#![allow(clippy::similar_names)]

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use xib_controller_backend::ControllerState;
use xib_protocol::InputEvent;

pub mod button {
    pub const DPAD_UP: u16 = 0x0001;
    pub const DPAD_DOWN: u16 = 0x0002;
    pub const DPAD_LEFT: u16 = 0x0004;
    pub const DPAD_RIGHT: u16 = 0x0008;
    pub const START: u16 = 0x0010;
    pub const BACK: u16 = 0x0020;
    pub const LEFT_THUMB: u16 = 0x0040;
    pub const RIGHT_THUMB: u16 = 0x0080;
    pub const LEFT_SHOULDER: u16 = 0x0100;
    pub const RIGHT_SHOULDER: u16 = 0x0200;
    pub const GUIDE: u16 = 0x0400;
    pub const A: u16 = 0x1000;
    pub const B: u16 = 0x2000;
    pub const X: u16 = 0x4000;
    pub const Y: u16 = 0x8000;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Button(u16),
    LeftXNegative,
    LeftXPositive,
    LeftYNegative,
    LeftYPositive,
    LeftTrigger,
    RightTrigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseCurve {
    Linear,
    Exponential,
    Precision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MouseSettings {
    pub sensitivity_x: f32,
    pub sensitivity_y: f32,
    pub invert_x: bool,
    pub invert_y: bool,
    pub deadzone: f32,
    pub curve: ResponseCurve,
}

impl Default for MouseSettings {
    fn default() -> Self {
        Self {
            sensitivity_x: 0.018,
            sensitivity_y: 0.018,
            invert_x: false,
            invert_y: false,
            deadzone: 0.0,
            curve: ResponseCurve::Linear,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub key_bindings: HashMap<String, Vec<Target>>,
    pub mouse_bindings: HashMap<u8, Vec<Target>>,
    pub mouse: MouseSettings,
}

impl Default for Profile {
    fn default() -> Self {
        let mut key_bindings = HashMap::new();
        let defaults = [
            ("KeyW", Target::LeftYPositive),
            ("KeyS", Target::LeftYNegative),
            ("KeyA", Target::LeftXNegative),
            ("KeyD", Target::LeftXPositive),
            ("Space", Target::Button(button::A)),
            ("ShiftLeft", Target::Button(button::LEFT_THUMB)),
            ("KeyE", Target::Button(button::B)),
            ("KeyR", Target::Button(button::X)),
            ("KeyQ", Target::Button(button::Y)),
            ("Escape", Target::Button(button::START)),
            ("Tab", Target::Button(button::BACK)),
        ];
        for (source, target) in defaults {
            key_bindings.insert(source.to_owned(), vec![target]);
        }

        let mut mouse_bindings = HashMap::new();
        mouse_bindings.insert(0, vec![Target::RightTrigger]);
        mouse_bindings.insert(2, vec![Target::LeftTrigger]);
        mouse_bindings.insert(1, vec![Target::Button(button::RIGHT_THUMB)]);

        Self {
            id: "default".into(),
            name: "Default".into(),
            key_bindings,
            mouse_bindings,
            mouse: MouseSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileValidationError(String);

impl std::fmt::Display for ProfileValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProfileValidationError {}

impl Profile {
    /// Validates all profile fields before the profile is used by a mapper.
    ///
    /// # Errors
    ///
    /// Returns an error when a field is unsupported or exceeds a runtime bound.
    pub fn validate(&self) -> Result<(), ProfileValidationError> {
        if !valid_profile_id(&self.id) {
            return Err(profile_error(
                "id must be 1-40 lowercase letters, numbers, '_' or '-'",
            ));
        }
        if self.name.trim().is_empty() || self.name.encode_utf16().count() > 60 {
            return Err(profile_error("name must be 1-60 characters"));
        }
        validate_bindings(&self.key_bindings)?;
        if self.mouse_bindings.len() > 128 {
            return Err(profile_error("mouse_bindings exceeds 128 bindings"));
        }
        for (source, targets) in &self.mouse_bindings {
            if *source > 4 {
                return Err(profile_error("mouse binding source must be 0-4"));
            }
            validate_targets(targets)?;
        }
        validate_number(self.mouse.sensitivity_x, 0.001, 0.2, "sensitivity_x")?;
        validate_number(self.mouse.sensitivity_y, 0.001, 0.2, "sensitivity_y")?;
        validate_number(self.mouse.deadzone, 0.0, 0.95, "deadzone")
    }
}

fn profile_error(message: impl Into<String>) -> ProfileValidationError {
    ProfileValidationError(message.into())
}

fn valid_profile_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
}

fn validate_bindings(
    bindings: &HashMap<String, Vec<Target>>,
) -> Result<(), ProfileValidationError> {
    if bindings.len() > 128 {
        return Err(profile_error("key_bindings exceeds 128 bindings"));
    }
    for (source, targets) in bindings {
        let mut characters = source.chars();
        if source.len() > 64
            || !characters
                .next()
                .is_some_and(|value| value.is_ascii_alphabetic())
            || !characters.all(|value| value.is_ascii_alphanumeric())
        {
            return Err(profile_error("invalid keyboard source"));
        }
        validate_targets(targets)?;
    }
    Ok(())
}

fn validate_targets(targets: &[Target]) -> Result<(), ProfileValidationError> {
    if !(1..=4).contains(&targets.len()) {
        return Err(profile_error("each binding must contain 1-4 targets"));
    }
    let mut unique = HashSet::new();
    for target in targets {
        if let Target::Button(mask) = target {
            const BUTTONS: [u16; 15] = [
                button::DPAD_UP,
                button::DPAD_DOWN,
                button::DPAD_LEFT,
                button::DPAD_RIGHT,
                button::START,
                button::BACK,
                button::LEFT_THUMB,
                button::RIGHT_THUMB,
                button::LEFT_SHOULDER,
                button::RIGHT_SHOULDER,
                button::GUIDE,
                button::A,
                button::B,
                button::X,
                button::Y,
            ];
            if !BUTTONS.contains(mask) {
                return Err(profile_error("unsupported controller button"));
            }
        }
        if !unique.insert(*target) {
            return Err(profile_error("binding contains duplicate targets"));
        }
    }
    Ok(())
}

fn validate_number(
    value: f32,
    minimum: f32,
    maximum: f32,
    field: &str,
) -> Result<(), ProfileValidationError> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(profile_error(format!(
            "{field} must be a finite number from {minimum} to {maximum}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Mapper {
    profile: Profile,
    pressed_keys: HashSet<String>,
    pressed_mouse_buttons: HashSet<u8>,
}

impl Mapper {
    #[must_use]
    pub fn new(profile: Profile) -> Self {
        Self {
            profile,
            pressed_keys: HashSet::new(),
            pressed_mouse_buttons: HashSet::new(),
        }
    }

    pub fn replace_profile(&mut self, profile: Profile) {
        self.reset();
        self.profile = profile;
    }

    pub fn reset(&mut self) {
        self.pressed_keys.clear();
        self.pressed_mouse_buttons.clear();
    }

    #[must_use]
    pub fn apply_batch(&mut self, events: &[InputEvent]) -> ControllerState {
        let mut mouse_dx = 0_i32;
        let mut mouse_dy = 0_i32;

        for event in events {
            match event {
                InputEvent::Key { code, down } => {
                    if *down {
                        self.pressed_keys.insert(code.clone());
                    } else {
                        self.pressed_keys.remove(code);
                    }
                }
                InputEvent::MouseButton { button, down } => {
                    if *down {
                        self.pressed_mouse_buttons.insert(*button);
                    } else {
                        self.pressed_mouse_buttons.remove(button);
                    }
                }
                InputEvent::MouseMove { dx, dy } => {
                    mouse_dx = mouse_dx.saturating_add(*dx);
                    mouse_dy = mouse_dy.saturating_add(*dy);
                }
                InputEvent::Wheel { .. } => {}
            }
        }

        self.build_state(mouse_dx, mouse_dy)
    }

    #[must_use]
    pub fn neutral_state(&mut self) -> ControllerState {
        self.reset();
        ControllerState::default()
    }

    fn active_targets(&self) -> impl Iterator<Item = Target> + '_ {
        let keys = self.pressed_keys.iter().flat_map(|source| {
            self.profile
                .key_bindings
                .get(source)
                .into_iter()
                .flatten()
                .copied()
        });
        let mouse = self.pressed_mouse_buttons.iter().flat_map(|source| {
            self.profile
                .mouse_bindings
                .get(source)
                .into_iter()
                .flatten()
                .copied()
        });
        keys.chain(mouse)
    }

    fn build_state(&self, mouse_dx: i32, mouse_dy: i32) -> ControllerState {
        let mut state = ControllerState::default();
        let mut left_x_negative = false;
        let mut left_x_positive = false;
        let mut left_y_negative = false;
        let mut left_y_positive = false;

        for target in self.active_targets() {
            match target {
                Target::Button(mask) => state.buttons |= mask,
                Target::LeftXNegative => left_x_negative = true,
                Target::LeftXPositive => left_x_positive = true,
                Target::LeftYNegative => left_y_negative = true,
                Target::LeftYPositive => left_y_positive = true,
                Target::LeftTrigger => state.left_trigger = u8::MAX,
                Target::RightTrigger => state.right_trigger = u8::MAX,
            }
        }

        state.left_x = digital_axis(left_x_negative, left_x_positive);
        state.left_y = digital_axis(left_y_negative, left_y_positive);
        state.right_x = mouse_axis(
            mouse_dx,
            self.profile.mouse.sensitivity_x,
            self.profile.mouse.invert_x,
            self.profile.mouse.deadzone,
            self.profile.mouse.curve,
        );
        state.right_y = mouse_axis(
            mouse_dy,
            self.profile.mouse.sensitivity_y,
            !self.profile.mouse.invert_y,
            self.profile.mouse.deadzone,
            self.profile.mouse.curve,
        );
        state
    }
}

fn digital_axis(negative: bool, positive: bool) -> i16 {
    match (negative, positive) {
        (true, false) => i16::MIN,
        (false, true) => i16::MAX,
        _ => 0,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn mouse_axis(
    delta: i32,
    sensitivity: f32,
    invert: bool,
    deadzone: f32,
    curve: ResponseCurve,
) -> i16 {
    if delta == 0 || !sensitivity.is_finite() || sensitivity <= 0.0 {
        return 0;
    }
    let direction = if invert { -1.0_f64 } else { 1.0_f64 };
    let normalized = (f64::from(delta) * f64::from(sensitivity) * direction).clamp(-1.0, 1.0);
    let deadzone = f64::from(deadzone.clamp(0.0, 0.95));
    let scaled = if normalized.abs() <= deadzone {
        0.0
    } else {
        normalized.signum() * ((normalized.abs() - deadzone) / (1.0 - deadzone))
    };
    let curved = scaled.signum()
        * match curve {
            ResponseCurve::Linear => scaled.abs(),
            ResponseCurve::Exponential => scaled.abs().powi(2),
            ResponseCurve::Precision => scaled.abs().powi(3),
        };
    (curved * f64::from(i16::MAX)).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opposite_digital_directions_cancel() {
        let mut mapper = Mapper::new(Profile::default());
        let state = mapper.apply_batch(&[
            InputEvent::Key {
                code: "KeyA".into(),
                down: true,
            },
            InputEvent::Key {
                code: "KeyD".into(),
                down: true,
            },
        ]);
        assert_eq!(state.left_x, 0);
    }

    #[test]
    fn multiple_bindings_do_not_release_each_other() {
        let mut profile = Profile::default();
        profile
            .key_bindings
            .insert("Enter".into(), vec![Target::Button(button::A)]);
        let mut mapper = Mapper::new(profile);
        let _ = mapper.apply_batch(&[
            InputEvent::Key {
                code: "Space".into(),
                down: true,
            },
            InputEvent::Key {
                code: "Enter".into(),
                down: true,
            },
        ]);
        let state = mapper.apply_batch(&[InputEvent::Key {
            code: "Space".into(),
            down: false,
        }]);
        assert_ne!(state.buttons & button::A, 0);
    }

    #[test]
    fn mouse_movement_is_transient_and_clamped() {
        let mut mapper = Mapper::new(Profile::default());
        let moved = mapper.apply_batch(&[InputEvent::MouseMove {
            dx: 1_000_000,
            dy: 0,
        }]);
        assert_eq!(moved.right_x, i16::MAX);
        let settled = mapper.apply_batch(&[]);
        assert_eq!(settled.right_x, 0);
    }

    #[test]
    fn minimum_vertical_delta_is_clamped_without_overflow() {
        for invert_y in [false, true] {
            let mut profile = Profile::default();
            profile.mouse.invert_y = invert_y;
            let mut mapper = Mapper::new(profile);
            let state = mapper.apply_batch(&[InputEvent::MouseMove {
                dx: 0,
                dy: i32::MIN,
            }]);
            assert_eq!(state.right_y, if invert_y { -i16::MAX } else { i16::MAX });
        }
    }

    #[test]
    fn reset_releases_everything() {
        let mut mapper = Mapper::new(Profile::default());
        let _ = mapper.apply_batch(&[InputEvent::Key {
            code: "Space".into(),
            down: true,
        }]);
        assert_eq!(mapper.neutral_state(), ControllerState::default());
    }

    #[test]
    fn validates_runtime_profile_bounds() {
        let mut profile = Profile::default();
        assert!(profile.validate().is_ok());
        profile.mouse.sensitivity_x = 0.201;
        assert!(profile.validate().is_err());
        profile = Profile::default();
        profile.key_bindings.insert(
            "KeyZ".into(),
            vec![Target::Button(button::A), Target::Button(button::A)],
        );
        assert!(profile.validate().is_err());
    }

    #[test]
    fn response_curves_are_deterministic_and_distinct() {
        let linear = mouse_axis(25, 0.02, false, 0.0, ResponseCurve::Linear);
        let exponential = mouse_axis(25, 0.02, false, 0.0, ResponseCurve::Exponential);
        let precision = mouse_axis(25, 0.02, false, 0.0, ResponseCurve::Precision);
        assert_eq!(linear, 16_383);
        assert_eq!(exponential, 8_192);
        assert_eq!(precision, 4_096);
    }
}
