#![deny(unsafe_op_in_unsafe_fn)]

//! Safe, bounded adapter for Windows Raw Input.
//!
//! This crate is the only Win32 `unsafe` boundary for local capture. The
//! boundary is isolated in `platform`: it creates a message-only window, copies
//! `WM_INPUT` bytes into an aligned bounded allocation, validates header/type
//! fields before reading union members, and immediately converts OS handles and
//! structures into owned safe values. Handles never escape that module.
//!
//! The adapter observes input; it does not suppress it. It has no injection,
//! process modification, elevation, anti-cheat, or network functionality.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread::JoinHandle,
};

use xib_local_input_core::{
    DeviceInstanceId, EventSequence, Generation, InputEvent, InputRecord, LifecycleEvent,
    TargetIdentity,
};

const CHANNEL_CAPACITY: usize = 256;
const RI_KEY_BREAK: u16 = 0x0001;
const RI_KEY_E0: u16 = 0x0002;
const RI_MOUSE_LEFT_DOWN: u16 = 0x0001;
const RI_MOUSE_LEFT_UP: u16 = 0x0002;
const RI_MOUSE_RIGHT_DOWN: u16 = 0x0004;
const RI_MOUSE_RIGHT_UP: u16 = 0x0008;
const RI_MOUSE_MIDDLE_DOWN: u16 = 0x0010;
const RI_MOUSE_MIDDLE_UP: u16 = 0x0020;
const RI_MOUSE_BUTTON_4_DOWN: u16 = 0x0040;
const RI_MOUSE_BUTTON_4_UP: u16 = 0x0080;
const RI_MOUSE_BUTTON_5_DOWN: u16 = 0x0100;
const RI_MOUSE_BUTTON_5_UP: u16 = 0x0200;
const RI_MOUSE_WHEEL: u16 = 0x0400;
const RI_MOUSE_HWHEEL: u16 = 0x0800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyboardTransition {
    pub event: InputEvent,
    pub virtual_key: u16,
}

#[must_use]
pub const fn translate_keyboard(
    make_code: u16,
    flags: u16,
    virtual_key: u16,
) -> KeyboardTransition {
    let code = make_code | if flags & RI_KEY_E0 != 0 { 0x0100 } else { 0 };
    KeyboardTransition {
        event: InputEvent::Key {
            code,
            pressed: flags & RI_KEY_BREAK == 0,
        },
        virtual_key,
    }
}

#[must_use]
pub fn translate_mouse(button_flags: u16, button_data: u16, dx: i32, dy: i32) -> Vec<InputEvent> {
    let mut events = Vec::with_capacity(7);
    if dx != 0 || dy != 0 {
        events.push(InputEvent::RelativeMotion { dx, dy });
    }
    for (down, up, button) in [
        (RI_MOUSE_LEFT_DOWN, RI_MOUSE_LEFT_UP, 0),
        (RI_MOUSE_MIDDLE_DOWN, RI_MOUSE_MIDDLE_UP, 1),
        (RI_MOUSE_RIGHT_DOWN, RI_MOUSE_RIGHT_UP, 2),
        (RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, 3),
        (RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, 4),
    ] {
        if button_flags & down != 0 {
            events.push(InputEvent::Button {
                button,
                pressed: true,
            });
        }
        if button_flags & up != 0 {
            events.push(InputEvent::Button {
                button,
                pressed: false,
            });
        }
    }
    if button_flags & RI_MOUSE_WHEEL != 0 {
        events.push(InputEvent::Wheel {
            horizontal: false,
            delta: button_data.cast_signed(),
        });
    }
    if button_flags & RI_MOUSE_HWHEEL != 0 {
        events.push(InputEvent::Wheel {
            horizontal: true,
            delta: button_data.cast_signed(),
        });
    }
    events
}

#[derive(Debug, Default)]
pub struct EmergencyChord {
    control: [bool; 2],
    alt: [bool; 2],
}

impl EmergencyChord {
    /// Updates Ctrl+Alt+F12 state. `true` is returned on the F12 press only.
    pub fn observe(&mut self, transition: KeyboardTransition) -> bool {
        let InputEvent::Key { code, pressed } = transition.event else {
            return false;
        };
        let extended = usize::from(code & 0x0100 != 0);
        match transition.virtual_key {
            0x11 => self.control[extended] = pressed,
            0xA2 => self.control[0] = pressed,
            0xA3 => self.control[1] = pressed,
            0x12 => self.alt[extended] = pressed,
            0xA4 => self.alt[0] = pressed,
            0xA5 => self.alt[1] = pressed,
            0x7B if pressed && self.control.contains(&true) && self.alt.contains(&true) => {
                return true;
            }
            _ => {}
        }
        false
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterEvent {
    Input(InputRecord),
    Lifecycle {
        generation: Generation,
        sequence: EventSequence,
        event: LifecycleEvent,
    },
    Emergency {
        generation: Generation,
        sequence: EventSequence,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalidation {
    InputOverload,
    AdapterError,
    Stopped,
}

#[derive(Debug)]
pub struct Startup {
    pub target: TargetIdentity,
    pub devices: Vec<DeviceInstanceId>,
}

#[derive(Debug)]
pub enum AdapterError {
    Unsupported,
    InvalidTarget(String),
    Win32(&'static str, u32),
    Startup(String),
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => formatter.write_str("Raw Input is only supported on Windows"),
            Self::InvalidTarget(message) | Self::Startup(message) => formatter.write_str(message),
            Self::Win32(api, code) => write!(formatter, "{api} failed with Windows error {code}"),
        }
    }
}

impl std::error::Error for AdapterError {}

pub struct RawInputAdapter {
    receiver: Receiver<AdapterEvent>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    invalidation: Arc<AtomicU64>,
    stop: platform::StopHandle,
    worker: Option<JoinHandle<()>>,
    startup: Startup,
}

impl RawInputAdapter {
    /// Starts the hidden Raw Input window and validates the target process.
    ///
    /// # Errors
    ///
    /// Returns an error if the target cannot be opened/identified or Win32
    /// registration and window creation fail.
    pub fn start(target_pid: u32) -> Result<Self, AdapterError> {
        if target_pid == 0 {
            return Err(AdapterError::InvalidTarget(
                "a non-zero target PID is required".into(),
            ));
        }
        let (sender, receiver) = sync_channel(CHANNEL_CAPACITY);
        let generation = Arc::new(AtomicU64::new(0));
        let active = Arc::new(AtomicBool::new(false));
        let invalidation = Arc::new(AtomicU64::new(0));
        let started = platform::spawn(
            target_pid,
            sender,
            Arc::clone(&generation),
            Arc::clone(&active),
            Arc::clone(&invalidation),
        )?;
        Ok(Self {
            receiver,
            generation,
            active,
            invalidation,
            stop: started.stop,
            worker: Some(started.worker),
            startup: started.startup,
        })
    }

    #[must_use]
    pub fn startup(&self) -> &Startup {
        &self.startup
    }

    pub fn bind_generation(&self, generation: Generation) {
        self.active.store(false, Ordering::Release);
        self.generation.store(generation.value(), Ordering::Release);
    }

    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Release);
    }

    #[must_use]
    pub const fn events(&self) -> &Receiver<AdapterEvent> {
        &self.receiver
    }

    #[must_use]
    pub fn take_invalidation(&self) -> Option<Invalidation> {
        match self.invalidation.swap(0, Ordering::AcqRel) {
            1 => Some(Invalidation::InputOverload),
            2 => Some(Invalidation::AdapterError),
            3 => Some(Invalidation::Stopped),
            _ => None,
        }
    }
}

impl Drop for RawInputAdapter {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.stop.request();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn send_bounded(sender: &SyncSender<AdapterEvent>, invalidation: &AtomicU64, event: AdapterEvent) {
    if sender.try_send(event).is_err() {
        invalidation.store(1, Ordering::Release);
    }
}

#[cfg(windows)]
mod platform;

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub struct StopHandle;
    impl StopHandle {
        pub fn request(&self) {}
    }
    pub struct Started {
        pub startup: Startup,
        pub stop: StopHandle,
        pub worker: JoinHandle<()>,
    }
    pub fn spawn(
        _target_pid: u32,
        _sender: SyncSender<AdapterEvent>,
        _generation: Arc<AtomicU64>,
        _active: Arc<AtomicBool>,
        _invalidation: Arc<AtomicU64>,
    ) -> Result<Started, AdapterError> {
        Err(AdapterError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_send_latches_overload() {
        let (sender, _receiver) = sync_channel(0);
        let invalidation = AtomicU64::new(0);
        send_bounded(
            &sender,
            &invalidation,
            AdapterEvent::Emergency {
                generation: Generation::new(1),
                sequence: EventSequence::new(1),
            },
        );
        assert_eq!(invalidation.load(Ordering::Acquire), 1);
    }

    #[test]
    fn keyboard_translation_preserves_break_and_extended_identity() {
        assert_eq!(
            translate_keyboard(0x1d, RI_KEY_BREAK | RI_KEY_E0, 0xA3).event,
            InputEvent::Key {
                code: 0x011d,
                pressed: false
            }
        );
    }

    #[test]
    fn emergency_chord_is_detected_on_press_before_mapping() {
        let mut chord = EmergencyChord::default();
        assert!(!chord.observe(translate_keyboard(0x1d, 0, 0x11)));
        assert!(!chord.observe(translate_keyboard(0x38, 0, 0x12)));
        assert!(chord.observe(translate_keyboard(0x58, 0, 0x7B)));
        assert!(!chord.observe(translate_keyboard(0x58, RI_KEY_BREAK, 0x7B)));
    }

    #[test]
    fn emergency_chord_preserves_the_other_held_modifier_side() {
        for (code, generic, left, right, other_code, other_key) in [
            (0x1d, 0x11, 0xA2, 0xA3, 0x38, 0x12),
            (0x38, 0x12, 0xA4, 0xA5, 0x1d, 0x11),
        ] {
            for (left_key, right_key) in [(generic, generic), (left, right)] {
                for released_side in [0, RI_KEY_E0] {
                    let mut chord = EmergencyChord::default();
                    chord.observe(translate_keyboard(other_code, 0, other_key));
                    chord.observe(translate_keyboard(code, 0, left_key));
                    chord.observe(translate_keyboard(code, RI_KEY_E0, right_key));
                    let released_key = if released_side == 0 {
                        left_key
                    } else {
                        right_key
                    };
                    chord.observe(translate_keyboard(
                        code,
                        released_side | RI_KEY_BREAK,
                        released_key,
                    ));
                    assert!(chord.observe(translate_keyboard(0x58, 0, 0x7B)));
                    chord.reset();
                    assert!(!chord.observe(translate_keyboard(0x58, 0, 0x7B)));
                }
            }
        }
    }

    #[test]
    fn mouse_translation_is_bounded_and_ordered() {
        let events = translate_mouse(
            RI_MOUSE_LEFT_DOWN | RI_MOUSE_MIDDLE_DOWN | RI_MOUSE_RIGHT_DOWN | RI_MOUSE_WHEEL,
            120,
            4,
            -3,
        );
        assert_eq!(
            events,
            vec![
                InputEvent::RelativeMotion { dx: 4, dy: -3 },
                InputEvent::Button {
                    button: 0,
                    pressed: true
                },
                InputEvent::Button {
                    button: 1,
                    pressed: true
                },
                InputEvent::Button {
                    button: 2,
                    pressed: true
                },
                InputEvent::Wheel {
                    horizontal: false,
                    delta: 120
                }
            ]
        );
    }
}
