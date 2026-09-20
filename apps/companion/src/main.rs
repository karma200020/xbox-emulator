use std::{
    env, fs,
    io::{self, Read, Write},
    process::ExitCode,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};

use xib_controller_backend::{ControllerBackend, FakeBackend};
use xib_mapping_core::{Mapper, Profile};
use xib_protocol::{ClientMessage, ErrorCode, HostMessage, PROTOCOL_VERSION, ValidationError};

const MAX_NATIVE_MESSAGE_BYTES: usize = 1_048_576;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(1_500);

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.iter().any(|value| value == "--local-diagnostics") {
        return local_diagnostics_entry(&arguments);
    }
    if arguments.iter().any(|value| value == "--native-messaging") {
        return native_messaging_main();
    }

    if let Some(origin) = arguments
        .iter()
        .find(|value| value.starts_with("chrome-extension://"))
    {
        if !is_allowed_extension_origin(origin) {
            eprintln!("Refusing untrusted extension origin");
            return ExitCode::FAILURE;
        }
        return native_messaging_main();
    }

    eprintln!(
        "Xbox Input Bridge companion foundation is installed.\n\
         Local capture is available only with explicit diagnostic arguments; \
         the production controller backend is not enabled."
    );
    ExitCode::SUCCESS
}

#[cfg(windows)]
fn local_diagnostics_entry(arguments: &[String]) -> ExitCode {
    let target_pid = arguments
        .windows(2)
        .find(|pair| pair[0] == "--target-pid")
        .and_then(|pair| pair[1].parse::<u32>().ok())
        .filter(|pid| *pid != 0);
    if !arguments.iter().any(|value| value == "--activate") {
        eprintln!("Local diagnostics requires the explicit --activate user action.");
        return ExitCode::FAILURE;
    }
    let Some(target_pid) = target_pid else {
        eprintln!("Local diagnostics requires --target-pid <non-zero PID>.");
        return ExitCode::FAILURE;
    };
    match run_local_diagnostics(target_pid) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Local diagnostics stopped safely: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn local_diagnostics_entry(_arguments: &[String]) -> ExitCode {
    eprintln!("Local diagnostics is available only on Windows.");
    ExitCode::FAILURE
}

#[cfg(windows)]
#[allow(clippy::too_many_lines)]
fn run_local_diagnostics(target_pid: u32) -> Result<(), String> {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Instant;
    use xib_controller_backend::ControllerState;
    use xib_local_input_core::{
        Command, CoordinatorConfig, CoordinatorState, InputEvent as LocalEvent, LifecycleEvent,
        LocalInputCoordinator, ModeOwner,
    };
    use xib_windows_raw_input::{AdapterEvent, Invalidation, RawInputAdapter};

    struct NeutralOnDrop {
        backend: FakeBackend,
    }
    impl Drop for NeutralOnDrop {
        fn drop(&mut self) {
            let _ = self.backend.update(ControllerState::default());
            let _ = self.backend.disconnect();
        }
    }

    fn apply_commands(
        commands: &[Command],
        coordinator: &mut LocalInputCoordinator,
        output: &mut NeutralOnDrop,
        mapper: &mut Mapper,
    ) -> Result<bool, String> {
        let mut stop = false;
        for command in commands {
            match command {
                Command::NeutralizeOutput { .. } => {
                    output
                        .backend
                        .update(ControllerState::default())
                        .map_err(|error| error.to_string())?;
                    coordinator.acknowledge_neutralized();
                }
                Command::DestroyOutput { .. } => {
                    output
                        .backend
                        .disconnect()
                        .map_err(|error| error.to_string())?;
                    coordinator.acknowledge_output_destroyed();
                    stop = true;
                }
                Command::ReleaseSuppression { .. } => {
                    // This mode never enables suppression.
                    coordinator.acknowledge_suppression_released();
                }
                Command::ClearHeldState { .. } => mapper.reset(),
                Command::DropQueuedInput { .. } => {}
            }
        }
        Ok(stop)
    }

    fn protocol_event(event: LocalEvent) -> Option<xib_protocol::InputEvent> {
        match event {
            LocalEvent::Key { code, pressed } => {
                scan_code_name(code).map(|code| xib_protocol::InputEvent::Key {
                    code: code.into(),
                    down: pressed,
                })
            }
            LocalEvent::Button { button, pressed } => Some(xib_protocol::InputEvent::MouseButton {
                button,
                down: pressed,
            }),
            LocalEvent::RelativeMotion { dx, dy } => {
                Some(xib_protocol::InputEvent::MouseMove { dx, dy })
            }
            LocalEvent::Wheel {
                horizontal: false,
                delta,
            } => Some(xib_protocol::InputEvent::Wheel {
                delta_y: i32::from(delta),
            }),
            LocalEvent::Wheel {
                horizontal: true, ..
            } => None,
        }
    }

    let adapter = RawInputAdapter::start(target_pid).map_err(|error| error.to_string())?;
    let mut output = NeutralOnDrop {
        backend: FakeBackend::default(),
    };
    output
        .backend
        .connect()
        .map_err(|error| error.to_string())?;
    let mut coordinator = LocalInputCoordinator::new(CoordinatorConfig::default());
    coordinator
        .claim_mode(ModeOwner::LocalInput)
        .map_err(|error| format!("cannot claim local mode: {error:?}"))?;
    let generation = coordinator
        .arm(
            adapter.startup().target.clone(),
            adapter.startup().devices.iter().copied(),
        )
        .map_err(|error| format!("cannot arm local mode: {error:?}"))?;
    adapter.bind_generation(generation);
    let mut mapper = Mapper::new(Profile::default());
    eprintln!(
        "Local diagnostics armed for PID {target_pid}; focus the target. \
             Ctrl+Alt+F12 is the emergency release chord. No input is suppressed."
    );
    let output_interval = Duration::from_millis(8);
    let mut next_output_tick = Instant::now() + output_interval;

    loop {
        if let Some(reason) = adapter.take_invalidation() {
            let lifecycle = match reason {
                Invalidation::Stopped => LifecycleEvent::Stop,
                Invalidation::InputOverload | Invalidation::AdapterError => {
                    LifecycleEvent::OutputHealthy(false)
                }
            };
            let commands = coordinator.handle_lifecycle(xib_local_input_core::EventRecord {
                generation: coordinator.generation(),
                sequence: xib_local_input_core::EventSequence::new(u64::MAX),
                event: lifecycle,
            });
            let _ = apply_commands(&commands, &mut coordinator, &mut output, &mut mapper);
            return Err(format!("adapter invalidation: {reason:?}"));
        }
        // Use an absolute deadline so lifecycle traffic cannot keep the last
        // mouse impulse held indefinitely after motion stops.
        if Instant::now() >= next_output_tick {
            if coordinator.state() == CoordinatorState::Active {
                refresh_local_output(&mut mapper, &mut output.backend)?;
            }
            next_output_tick = Instant::now() + output_interval;
        }
        match adapter
            .events()
            .recv_timeout(next_output_tick.saturating_duration_since(Instant::now()))
        {
            Ok(AdapterEvent::Lifecycle {
                generation,
                sequence,
                event,
            }) => {
                let commands = coordinator.handle_lifecycle(xib_local_input_core::EventRecord {
                    generation,
                    sequence,
                    event,
                });
                if apply_commands(&commands, &mut coordinator, &mut output, &mut mapper)? {
                    return Ok(());
                }
                if coordinator.state() == CoordinatorState::Armed
                    && coordinator.activate(generation).is_ok()
                {
                    adapter.set_active(true);
                    eprintln!("Local diagnostics active for the focused target.");
                }
                if coordinator.state() == CoordinatorState::Inactive {
                    return Ok(());
                }
            }
            Ok(AdapterEvent::Emergency {
                generation,
                sequence,
            }) => {
                let outcome = coordinator.emergency_release(generation, sequence);
                apply_commands(
                    &outcome.commands,
                    &mut coordinator,
                    &mut output,
                    &mut mapper,
                )?;
                eprintln!("Emergency release activated; controller is neutral.");
                return Ok(());
            }
            Ok(AdapterEvent::Input(record)) => {
                let outcome = coordinator.accept_input(record);
                if apply_commands(
                    &outcome.commands,
                    &mut coordinator,
                    &mut output,
                    &mut mapper,
                )? {
                    return Ok(());
                }
                if coordinator.state() == CoordinatorState::Inactive {
                    return Ok(());
                }
                for record in coordinator.drain_input(32) {
                    if let Some(event) = protocol_event(record.event) {
                        let state = mapper.apply_batch(&[event]);
                        if let Err(error) = output.backend.update(state) {
                            let commands =
                                coordinator.handle_lifecycle(xib_local_input_core::EventRecord {
                                    generation: coordinator.generation(),
                                    sequence: xib_local_input_core::EventSequence::new(u64::MAX),
                                    event: LifecycleEvent::OutputHealthy(false),
                                });
                            let _ = apply_commands(
                                &commands,
                                &mut coordinator,
                                &mut output,
                                &mut mapper,
                            );
                            return Err(error.to_string());
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Raw Input worker disconnected".into());
            }
        }
    }
}

#[cfg(windows)]
fn scan_code_name(code: u16) -> Option<&'static str> {
    Some(match code {
        0x11 => "KeyW",
        0x1f => "KeyS",
        0x1e => "KeyA",
        0x20 => "KeyD",
        0x39 => "Space",
        0x2a => "ShiftLeft",
        0x36 => "ShiftRight",
        0x12 => "KeyE",
        0x13 => "KeyR",
        0x10 => "KeyQ",
        0x01 => "Escape",
        0x0f => "Tab",
        _ => return None,
    })
}

#[cfg(windows)]
fn refresh_local_output(
    mapper: &mut Mapper,
    backend: &mut impl ControllerBackend,
) -> Result<(), String> {
    backend
        .update(mapper.apply_batch(&[]))
        .map_err(|error| error.to_string())
}

fn is_allowed_extension_origin(origin: &str) -> bool {
    let Ok(local_app_data) = env::var("LOCALAPPDATA") else {
        return false;
    };
    let path = std::path::Path::new(&local_app_data)
        .join("XboxInputBridge")
        .join("allowed-origin.txt");
    fs::read_to_string(path).is_ok_and(|expected| expected.trim() == origin)
}

fn native_messaging_main() -> ExitCode {
    let (sender, receiver) = mpsc::sync_channel(32);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match read_native_message(&mut input) {
                Ok(Some(message)) => {
                    if sender.send(Ok(message)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });

    let mut output = io::stdout().lock();
    let mut backend = FakeBackend::default();
    if let Err(error) = backend.connect() {
        let _ = write_host_message(
            &mut output,
            &HostMessage::Error {
                code: ErrorCode::BackendUnavailable,
                message: error.to_string(),
            },
        );
        return ExitCode::FAILURE;
    }

    let mut session = Session::new(backend);
    loop {
        match receiver.recv_timeout(HEARTBEAT_TIMEOUT) {
            Ok(Ok(message)) => {
                let response = session.handle(message);
                if write_host_message(&mut output, &response).is_err() {
                    break;
                }
            }
            Ok(Err(error)) => {
                let response = HostMessage::Error {
                    code: ErrorCode::InvalidMessage,
                    message: error.to_string(),
                };
                let _ = write_host_message(&mut output, &response);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                if session.active {
                    session.deactivate();
                    if write_host_message(
                        &mut output,
                        &HostMessage::Status {
                            active: false,
                            profile_id: None,
                        },
                    )
                    .is_err()
                    {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    session.deactivate();
    let _ = session.backend.disconnect();
    ExitCode::SUCCESS
}

struct Session<B: ControllerBackend> {
    backend: B,
    mapper: Mapper,
    hello_received: bool,
    active: bool,
    profile_id: Option<String>,
    loaded_profile_id: Option<String>,
    last_sequence: Option<u64>,
}

impl<B: ControllerBackend> Session<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            mapper: Mapper::new(Profile::default()),
            hello_received: false,
            active: false,
            profile_id: None,
            loaded_profile_id: None,
            last_sequence: None,
        }
    }

    fn handle(&mut self, message: ClientMessage) -> HostMessage {
        if let Err(error) = message.validate() {
            self.deactivate();
            return validation_error_message(&error);
        }

        match message {
            ClientMessage::Hello { .. } => {
                self.deactivate();
                self.hello_received = true;
                HostMessage::HelloAck {
                    protocol_version: PROTOCOL_VERSION,
                    host_version: env!("CARGO_PKG_VERSION").into(),
                    backend: self.backend.name().into(),
                }
            }
            ClientMessage::Activate { profile_id } if self.hello_received => {
                if self.loaded_profile_id.as_deref() != Some(&profile_id) {
                    self.deactivate();
                    return HostMessage::Error {
                        code: ErrorCode::InvalidProfile,
                        message: "profile must be validated and applied before activation".into(),
                    };
                }
                if let Err(error) = self.neutralize() {
                    return error;
                }
                self.active = true;
                self.profile_id = Some(profile_id.clone());
                HostMessage::Status {
                    active: true,
                    profile_id: Some(profile_id),
                }
            }
            ClientMessage::SetProfile {
                schema_version: _,
                profile,
            } if self.hello_received => self.set_profile(profile),
            ClientMessage::Deactivate { .. } if self.hello_received => {
                self.deactivate();
                HostMessage::Status {
                    active: false,
                    profile_id: None,
                }
            }
            ClientMessage::Heartbeat { sequence } if self.hello_received => {
                if !self.accept_sequence(sequence) {
                    return sequence_error();
                }
                HostMessage::Ack { sequence }
            }
            ClientMessage::InputBatch {
                sequence, events, ..
            } if self.hello_received && self.active => {
                if !self.accept_sequence(sequence) {
                    return sequence_error();
                }
                let state = self.mapper.apply_batch(&events);
                if let Err(error) = self.backend.update(state) {
                    self.deactivate();
                    return HostMessage::Error {
                        code: ErrorCode::BackendUnavailable,
                        message: error.to_string(),
                    };
                }
                HostMessage::Ack { sequence }
            }
            _ => HostMessage::Error {
                code: ErrorCode::InvalidState,
                message: "message is not valid in the current session state".into(),
            },
        }
    }

    fn deactivate(&mut self) {
        let _ = self.neutralize();
    }

    fn set_profile(&mut self, raw_profile: serde_json::Value) -> HostMessage {
        if !has_valid_mouse_binding_keys(&raw_profile) {
            self.deactivate();
            return HostMessage::Error {
                code: ErrorCode::InvalidProfile,
                message: "mouse binding sources must be canonical integers from 0 to 4".into(),
            };
        }
        let profile = match serde_json::from_value::<Profile>(raw_profile) {
            Ok(profile) => profile,
            Err(error) => {
                self.deactivate();
                return HostMessage::Error {
                    code: ErrorCode::InvalidProfile,
                    message: format!("profile document is invalid: {error}"),
                };
            }
        };
        if let Err(error) = profile.validate() {
            self.deactivate();
            return HostMessage::Error {
                code: ErrorCode::InvalidProfile,
                message: error.to_string(),
            };
        }
        if let Err(error) = self.neutralize() {
            return error;
        }
        let profile_id = profile.id.clone();
        self.mapper.replace_profile(profile);
        self.loaded_profile_id = Some(profile_id.clone());
        HostMessage::ProfileApplied { profile_id }
    }

    fn neutralize(&mut self) -> Result<(), HostMessage> {
        let neutral = self.mapper.neutral_state();
        self.active = false;
        self.profile_id = None;
        self.last_sequence = None;
        self.backend
            .update(neutral)
            .map_err(|error| HostMessage::Error {
                code: ErrorCode::BackendUnavailable,
                message: error.to_string(),
            })
    }

    fn accept_sequence(&mut self, sequence: u64) -> bool {
        if self.last_sequence.is_some_and(|last| sequence <= last) {
            self.deactivate();
            return false;
        }
        self.last_sequence = Some(sequence);
        true
    }
}

fn has_valid_mouse_binding_keys(profile: &serde_json::Value) -> bool {
    profile
        .get("mouse_bindings")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|bindings| {
            bindings
                .keys()
                .all(|source| matches!(source.as_str(), "0" | "1" | "2" | "3" | "4"))
        })
}

fn sequence_error() -> HostMessage {
    HostMessage::Error {
        code: ErrorCode::InvalidState,
        message: "message sequence must increase monotonically".into(),
    }
}

fn validation_error_message(error: &ValidationError) -> HostMessage {
    let code = if matches!(error, ValidationError::ProtocolVersion { .. }) {
        ErrorCode::ProtocolMismatch
    } else {
        ErrorCode::InvalidMessage
    };
    HostMessage::Error {
        code,
        message: error.to_string(),
    }
}

fn read_native_message(reader: &mut impl Read) -> io::Result<Option<ClientMessage>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read(&mut length_bytes[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("one-byte read returned more than one byte"),
        Err(error) => return Err(error),
    }
    reader.read_exact(&mut length_bytes[1..])?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_NATIVE_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Native Messaging message length",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_host_message(writer: &mut impl Write, message: &HostMessage) -> io::Result<()> {
    let payload = serde_json::to_vec(message)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let length = u32::try_from(payload.len())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, ErrorKind};
    use xib_controller_backend::ControllerState;
    use xib_protocol::InputEvent;

    fn connected_session() -> Session<FakeBackend> {
        let mut backend = FakeBackend::default();
        backend.connect().unwrap();
        Session::new(backend)
    }

    fn active_session() -> Session<FakeBackend> {
        let mut session = connected_session();
        assert!(matches!(
            session.handle(ClientMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                client_version: "test".into(),
            }),
            HostMessage::HelloAck { .. }
        ));
        assert!(matches!(
            session.handle(ClientMessage::SetProfile {
                schema_version: xib_protocol::PROFILE_SCHEMA_VERSION,
                profile: serde_json::to_value(Profile::default()).unwrap(),
            }),
            HostMessage::ProfileApplied { .. }
        ));
        assert!(matches!(
            session.handle(ClientMessage::Activate {
                profile_id: "default".into(),
            }),
            HostMessage::Status { active: true, .. }
        ));
        session
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 + payload.len());
        bytes.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn press_space(session: &mut Session<FakeBackend>, sequence: u64) {
        assert_eq!(
            session.handle(ClientMessage::InputBatch {
                sequence,
                timestamp_ms: 1,
                events: vec![InputEvent::Key {
                    code: "Space".into(),
                    down: true,
                }],
            }),
            HostMessage::Ack { sequence }
        );
    }

    #[test]
    fn requires_hello_before_activation() {
        let mut backend = FakeBackend::default();
        backend.connect().unwrap();
        let mut session = Session::new(backend);
        assert!(matches!(
            session.handle(ClientMessage::Activate {
                profile_id: "default".into()
            }),
            HostMessage::Error {
                code: ErrorCode::InvalidState,
                ..
            }
        ));
    }

    #[test]
    fn repeated_sequence_neutralizes_session() {
        let mut session = active_session();
        let state = session.backend.shared_state();
        press_space(&mut session, 1);
        let response = session.handle(ClientMessage::InputBatch {
            sequence: 1,
            timestamp_ms: 2,
            events: vec![],
        });
        assert!(matches!(response, HostMessage::Error { .. }));
        assert_eq!(
            *state.lock().unwrap(),
            xib_controller_backend::ControllerState::default()
        );
        assert!(!session.active);
    }

    #[cfg(windows)]
    #[test]
    fn local_output_refresh_settles_mouse_without_releasing_held_controls() {
        let mut backend = FakeBackend::default();
        backend.connect().unwrap();
        let shared = backend.shared_state();
        let mut mapper = Mapper::new(Profile::default());
        backend
            .update(mapper.apply_batch(&[
                InputEvent::Key {
                    code: "Space".into(),
                    down: true,
                },
                InputEvent::MouseButton {
                    button: 0,
                    down: true,
                },
                InputEvent::MouseMove { dx: 10, dy: -10 },
            ]))
            .unwrap();
        assert_ne!(shared.lock().unwrap().right_x, 0);

        refresh_local_output(&mut mapper, &mut backend).unwrap();
        assert_eq!(
            *shared.lock().unwrap(),
            ControllerState {
                buttons: xib_mapping_core::button::A,
                right_trigger: u8::MAX,
                ..ControllerState::default()
            }
        );
    }

    #[test]
    fn rejects_every_message_that_requires_a_handshake() {
        let messages = [
            ClientMessage::Activate {
                profile_id: "default".into(),
            },
            ClientMessage::SetProfile {
                schema_version: xib_protocol::PROFILE_SCHEMA_VERSION,
                profile: serde_json::to_value(Profile::default()).unwrap(),
            },
            ClientMessage::Deactivate {
                reason: "test".into(),
            },
            ClientMessage::Heartbeat { sequence: 1 },
            ClientMessage::InputBatch {
                sequence: 1,
                timestamp_ms: 1,
                events: vec![],
            },
        ];

        for message in messages {
            let mut session = connected_session();
            assert!(matches!(
                session.handle(message),
                HostMessage::Error {
                    code: ErrorCode::InvalidState,
                    ..
                }
            ));
            assert!(!session.hello_received);
            assert!(!session.active);
        }
    }

    #[test]
    fn repeated_hello_neutralizes_an_active_session() {
        let mut session = active_session();
        let state = session.backend.shared_state();
        press_space(&mut session, 1);

        assert!(matches!(
            session.handle(ClientMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                client_version: "reconnected".into(),
            }),
            HostMessage::HelloAck { .. }
        ));
        assert!(!session.active);
        assert_eq!(*state.lock().unwrap(), ControllerState::default());
    }

    #[test]
    fn switching_profile_while_active_neutralizes_before_replacement() {
        let mut session = active_session();
        let state = session.backend.shared_state();
        press_space(&mut session, 1);
        assert_ne!(state.lock().unwrap().buttons, 0);

        let mut replacement = Profile {
            id: "alternate".into(),
            name: "Alternate".into(),
            ..Profile::default()
        };
        replacement.key_bindings.clear();
        assert_eq!(
            session.handle(ClientMessage::SetProfile {
                schema_version: xib_protocol::PROFILE_SCHEMA_VERSION,
                profile: serde_json::to_value(replacement).unwrap(),
            }),
            HostMessage::ProfileApplied {
                profile_id: "alternate".into()
            }
        );
        assert_eq!(*state.lock().unwrap(), ControllerState::default());
        assert!(!session.active);
        assert_eq!(session.loaded_profile_id.as_deref(), Some("alternate"));
    }

    #[test]
    fn invalid_profile_never_replaces_active_profile() {
        let mut session = active_session();
        let state = session.backend.shared_state();
        press_space(&mut session, 1);
        let invalid = serde_json::json!({
            "id": "alternate",
            "name": "Alternate",
            "key_bindings": {},
            "mouse_bindings": {},
            "mouse": {
                "sensitivity_x": 9.0,
                "sensitivity_y": 0.018,
                "invert_x": false,
                "invert_y": false,
                "deadzone": 0.0,
                "curve": "linear"
            },
            "unknown": true
        });

        assert!(matches!(
            session.handle(ClientMessage::SetProfile {
                schema_version: xib_protocol::PROFILE_SCHEMA_VERSION,
                profile: invalid,
            }),
            HostMessage::Error {
                code: ErrorCode::InvalidProfile,
                ..
            }
        ));
        assert_eq!(*state.lock().unwrap(), ControllerState::default());
        assert_eq!(session.loaded_profile_id.as_deref(), Some("default"));
        assert!(!session.active);
    }

    #[test]
    fn heartbeat_sequences_are_monotonic_across_message_types() {
        for repeated_sequence in [10, 9] {
            let mut session = active_session();
            let state = session.backend.shared_state();
            press_space(&mut session, 10);

            let response = session.handle(ClientMessage::Heartbeat {
                sequence: repeated_sequence,
            });
            assert!(matches!(
                response,
                HostMessage::Error {
                    code: ErrorCode::InvalidState,
                    ..
                }
            ));
            assert!(!session.active);
            assert_eq!(*state.lock().unwrap(), ControllerState::default());
        }

        let mut session = active_session();
        assert_eq!(
            session.handle(ClientMessage::Heartbeat { sequence: 20 }),
            HostMessage::Ack { sequence: 20 }
        );
        assert!(matches!(
            session.handle(ClientMessage::InputBatch {
                sequence: 19,
                timestamp_ms: 1,
                events: vec![],
            }),
            HostMessage::Error {
                code: ErrorCode::InvalidState,
                ..
            }
        ));
        assert!(!session.active);
    }

    #[test]
    fn explicit_deactivation_neutralizes_and_resets_sequence() {
        let mut session = active_session();
        let state = session.backend.shared_state();
        press_space(&mut session, 42);

        assert_eq!(
            session.handle(ClientMessage::Deactivate {
                reason: "capture ended".into(),
            }),
            HostMessage::Status {
                active: false,
                profile_id: None,
            }
        );
        assert_eq!(*state.lock().unwrap(), ControllerState::default());
        assert!(!session.active);
        assert_eq!(session.last_sequence, None);
    }

    #[test]
    fn invalid_active_messages_neutralize_the_controller() {
        let invalid_messages = [
            ClientMessage::Activate {
                profile_id: String::new(),
            },
            ClientMessage::InputBatch {
                sequence: 2,
                timestamp_ms: 1,
                events: vec![InputEvent::MouseButton {
                    button: 5,
                    down: true,
                }],
            },
            ClientMessage::Hello {
                protocol_version: PROTOCOL_VERSION + 1,
                client_version: "test".into(),
            },
        ];

        for message in invalid_messages {
            let mut session = active_session();
            let state = session.backend.shared_state();
            press_space(&mut session, 1);
            assert!(matches!(session.handle(message), HostMessage::Error { .. }));
            assert!(!session.active);
            assert_eq!(*state.lock().unwrap(), ControllerState::default());
        }
    }

    #[test]
    fn native_message_reader_handles_clean_and_truncated_eof() {
        assert_eq!(read_native_message(&mut Cursor::new([])).unwrap(), None);

        for bytes in [
            vec![1],
            vec![1, 0],
            vec![1, 0, 0],
            framed(br#"{"type":"heartbeat","sequence":1}"#)[..10].to_vec(),
        ] {
            assert_eq!(
                read_native_message(&mut Cursor::new(bytes))
                    .unwrap_err()
                    .kind(),
                ErrorKind::UnexpectedEof
            );
        }
    }

    #[test]
    fn native_message_reader_rejects_invalid_lengths() {
        for length in [0_u32, u32::try_from(MAX_NATIVE_MESSAGE_BYTES + 1).unwrap()] {
            assert_eq!(
                read_native_message(&mut Cursor::new(length.to_le_bytes()))
                    .unwrap_err()
                    .kind(),
                ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn native_message_reader_rejects_malformed_and_unknown_json() {
        for payload in [
            br#"{"type":"heartbeat","sequence":"wrong"}"#.as_slice(),
            br#"{"type":"heartbeat","sequence":1,"unknown":true}"#.as_slice(),
            br#"{"type":"heartbeat""#.as_slice(),
        ] {
            assert_eq!(
                read_native_message(&mut Cursor::new(framed(payload)))
                    .unwrap_err()
                    .kind(),
                ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn native_message_round_trip_uses_little_endian_framing() {
        let message = HostMessage::Error {
            code: ErrorCode::InvalidMessage,
            message: "bad input".into(),
        };
        let mut bytes = Vec::new();
        write_host_message(&mut bytes, &message).unwrap();

        let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 4);
        assert_eq!(
            serde_json::from_slice::<HostMessage>(&bytes[4..]).unwrap(),
            message
        );
    }
}
