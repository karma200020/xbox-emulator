use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_BATCH_EVENTS: usize = 512;
pub const MAX_PROFILE_ID_BYTES: usize = 40;
pub const MAX_KEY_CODE_BYTES: usize = 64;
pub const MAX_REASON_BYTES: usize = 256;
pub const PROFILE_SCHEMA_VERSION: u16 = 1;
pub const MAX_PROFILE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    Hello {
        protocol_version: u16,
        client_version: String,
    },
    Activate {
        profile_id: String,
    },
    SetProfile {
        schema_version: u16,
        profile: serde_json::Value,
    },
    Deactivate {
        reason: String,
    },
    Heartbeat {
        sequence: u64,
    },
    InputBatch {
        sequence: u64,
        timestamp_ms: u64,
        events: Vec<InputEvent>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputEvent {
    Key { code: String, down: bool },
    MouseMove { dx: i32, dy: i32 },
    MouseButton { button: u8, down: bool },
    Wheel { delta_y: i32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostMessage {
    HelloAck {
        protocol_version: u16,
        host_version: String,
        backend: String,
    },
    Status {
        active: bool,
        profile_id: Option<String>,
    },
    ProfileApplied {
        profile_id: String,
    },
    Ack {
        sequence: u64,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidMessage,
    ProtocolMismatch,
    InvalidState,
    BackendUnavailable,
    InvalidProfile,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("protocol version {actual} is unsupported; expected {expected}")]
    ProtocolVersion { actual: u16, expected: u16 },
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} exceeds {max} bytes")]
    TooLong { field: &'static str, max: usize },
    #[error("input batch exceeds {MAX_BATCH_EVENTS} events")]
    BatchTooLarge,
    #[error("mouse button {0} is unsupported")]
    MouseButton(u8),
    #[error("{field} value {value} exceeds the allowed magnitude {max}")]
    OutOfRange {
        field: &'static str,
        value: i32,
        max: i32,
    },
    #[error("profile schema version {actual} is unsupported; expected {expected}")]
    ProfileSchemaVersion { actual: u16, expected: u16 },
    #[error("serialized profile exceeds {MAX_PROFILE_BYTES} bytes")]
    ProfileTooLarge,
}

impl ClientMessage {
    /// Validates all message fields against protocol limits.
    ///
    /// # Errors
    ///
    /// Returns the first field or protocol validation failure.
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Hello {
                protocol_version,
                client_version,
            } => {
                if *protocol_version != PROTOCOL_VERSION {
                    return Err(ValidationError::ProtocolVersion {
                        actual: *protocol_version,
                        expected: PROTOCOL_VERSION,
                    });
                }
                validate_text("client_version", client_version, 64)
            }
            Self::Activate { profile_id } => {
                validate_text("profile_id", profile_id, MAX_PROFILE_ID_BYTES)
            }
            Self::SetProfile {
                schema_version,
                profile,
            } => {
                if *schema_version != PROFILE_SCHEMA_VERSION {
                    return Err(ValidationError::ProfileSchemaVersion {
                        actual: *schema_version,
                        expected: PROFILE_SCHEMA_VERSION,
                    });
                }
                if serde_json::to_vec(profile).map_or(true, |value| value.len() > MAX_PROFILE_BYTES)
                {
                    return Err(ValidationError::ProfileTooLarge);
                }
                Ok(())
            }
            Self::Deactivate { reason } => {
                validate_optional_text("reason", reason, MAX_REASON_BYTES)
            }
            Self::Heartbeat { .. } => Ok(()),
            Self::InputBatch { events, .. } => {
                if events.len() > MAX_BATCH_EVENTS {
                    return Err(ValidationError::BatchTooLarge);
                }
                for event in events {
                    event.validate()?;
                }
                Ok(())
            }
        }
    }
}

impl InputEvent {
    /// Validates an input event against protocol limits.
    ///
    /// # Errors
    ///
    /// Returns an error for unsupported controls or out-of-range values.
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Key { code, .. } => validate_text("key code", code, MAX_KEY_CODE_BYTES),
            Self::MouseMove { dx, dy } => {
                validate_range("mouse dx", *dx, 100_000)?;
                validate_range("mouse dy", *dy, 100_000)
            }
            Self::MouseButton { button, .. } if *button > 4 => {
                Err(ValidationError::MouseButton(*button))
            }
            Self::Wheel { delta_y } => validate_range("wheel delta", *delta_y, 100_000),
            Self::MouseButton { .. } => Ok(()),
        }
    }
}

fn validate_text(field: &'static str, value: &str, max: usize) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    validate_optional_text(field, value, max)
}

fn validate_optional_text(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<(), ValidationError> {
    if value.len() > max {
        return Err(ValidationError::TooLong { field, max });
    }
    Ok(())
}

fn validate_range(field: &'static str, value: i32, max: i32) -> Result<(), ValidationError> {
    if value.unsigned_abs() > max.unsigned_abs() {
        return Err(ValidationError::OutOfRange { field, value, max });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_batch(events: Vec<InputEvent>) -> ClientMessage {
        ClientMessage::InputBatch {
            sequence: 1,
            timestamp_ms: 1,
            events,
        }
    }

    #[test]
    fn rejects_wrong_protocol_version() {
        let message = ClientMessage::Hello {
            protocol_version: 2,
            client_version: "0.1.0".into(),
        };
        assert!(matches!(
            message.validate(),
            Err(ValidationError::ProtocolVersion { .. })
        ));
    }

    #[test]
    fn rejects_oversized_batch() {
        let events = vec![
            InputEvent::Key {
                code: "KeyA".into(),
                down: true,
            };
            MAX_BATCH_EVENTS + 1
        ];
        let message = ClientMessage::InputBatch {
            sequence: 1,
            timestamp_ms: 1,
            events,
        };
        assert_eq!(message.validate(), Err(ValidationError::BatchTooLarge));
    }

    #[test]
    fn accepts_supported_mouse_buttons() {
        for button in 0..=4 {
            assert!(
                InputEvent::MouseButton { button, down: true }
                    .validate()
                    .is_ok()
            );
        }
    }

    #[test]
    fn rejects_unknown_json_fields() {
        let messages = [
            r#"{"type":"hello","protocol_version":1,"client_version":"test","extra":true}"#,
            r#"{"type":"activate","profile_id":"default","extra":true}"#,
            r#"{"type":"input_batch","sequence":1,"timestamp_ms":1,"events":[{"kind":"key","code":"KeyA","down":true,"extra":true}]}"#,
        ];
        for json in messages {
            assert!(
                serde_json::from_str::<ClientMessage>(json).is_err(),
                "{json}"
            );
        }

        assert!(
            serde_json::from_str::<HostMessage>(
                r#"{"type":"ack","sequence":1,"unexpected":"field"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_malformed_or_incomplete_json_messages() {
        for json in [
            "",
            "{",
            r#"{"type":"heartbeat"}"#,
            r#"{"type":"input_batch","sequence":"one","timestamp_ms":1,"events":[]}"#,
            r#"{"type":"not_a_message"}"#,
        ] {
            assert!(
                serde_json::from_str::<ClientMessage>(json).is_err(),
                "{json}"
            );
        }
    }

    #[test]
    fn validates_all_bounded_text_fields_by_utf8_bytes() {
        let cases = [
            ClientMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                client_version: String::new(),
            },
            ClientMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                client_version: "x".repeat(65),
            },
            ClientMessage::Activate {
                profile_id: String::new(),
            },
            ClientMessage::Activate {
                profile_id: "é".repeat(MAX_PROFILE_ID_BYTES / 2 + 1),
            },
        ];
        for message in cases {
            assert!(message.validate().is_err(), "{message:?}");
        }

        assert_eq!(
            ClientMessage::Deactivate {
                reason: "x".repeat(MAX_REASON_BYTES + 1)
            }
            .validate(),
            Err(ValidationError::TooLong {
                field: "reason",
                max: MAX_REASON_BYTES
            })
        );
    }

    #[test]
    fn rejects_invalid_input_events() {
        let cases = [
            InputEvent::Key {
                code: String::new(),
                down: true,
            },
            InputEvent::Key {
                code: "x".repeat(MAX_KEY_CODE_BYTES + 1),
                down: true,
            },
            InputEvent::MouseButton {
                button: 5,
                down: true,
            },
            InputEvent::MouseMove { dx: 100_001, dy: 0 },
            InputEvent::MouseMove {
                dx: 0,
                dy: -100_001,
            },
            InputEvent::Wheel { delta_y: i32::MIN },
        ];

        for event in cases {
            assert!(valid_batch(vec![event]).validate().is_err());
        }
    }

    #[test]
    fn accepts_validation_boundaries() {
        assert!(
            ClientMessage::Activate {
                profile_id: "x".repeat(MAX_PROFILE_ID_BYTES)
            }
            .validate()
            .is_ok()
        );
        assert!(
            valid_batch(vec![
                InputEvent::MouseMove {
                    dx: -100_000,
                    dy: 100_000,
                };
                MAX_BATCH_EVENTS
            ])
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn set_profile_is_versioned_and_size_bounded() {
        let valid = ClientMessage::SetProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            profile: serde_json::json!({"id": "default"}),
        };
        assert!(valid.validate().is_ok());
        assert!(matches!(
            ClientMessage::SetProfile {
                schema_version: PROFILE_SCHEMA_VERSION + 1,
                profile: serde_json::json!({}),
            }
            .validate(),
            Err(ValidationError::ProfileSchemaVersion { .. })
        ));
        assert_eq!(
            ClientMessage::SetProfile {
                schema_version: PROFILE_SCHEMA_VERSION,
                profile: serde_json::Value::String("x".repeat(MAX_PROFILE_BYTES)),
            }
            .validate(),
            Err(ValidationError::ProfileTooLarge)
        );
    }
}
