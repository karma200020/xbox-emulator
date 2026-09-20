#![allow(clippy::similar_names)]

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
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
    pub smoothing: f32,
    pub velocity_scale: f32,
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
            smoothing: 0.0,
            velocity_scale: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdsActivation {
    Key { code: String },
    MouseButton { button: u8 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MouseModes {
    pub hip: MouseSettings,
    pub ads: MouseSettings,
    pub ads_activation: Option<AdsActivation>,
}

impl Default for MouseModes {
    fn default() -> Self {
        let response = MouseSettings::default();
        Self {
            hip: response.clone(),
            ads: response,
            ads_activation: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GameAssociation {
    pub title_id: String,
    pub title_name: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub key_bindings: HashMap<String, Vec<Target>>,
    pub mouse_bindings: HashMap<u8, Vec<Target>>,
    pub mouse: MouseModes,
    pub game_associations: Vec<GameAssociation>,
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
            mouse: MouseModes::default(),
            game_associations: Vec::new(),
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
        validate_mouse_settings(&self.mouse.hip, "mouse.hip")?;
        validate_mouse_settings(&self.mouse.ads, "mouse.ads")?;
        if let Some(source) = &self.mouse.ads_activation {
            match source {
                AdsActivation::Key { code } if !self.key_bindings.contains_key(code) => {
                    return Err(profile_error(
                        "mouse.ads_activation must reference an existing keyboard binding",
                    ));
                }
                AdsActivation::MouseButton { button }
                    if !self.mouse_bindings.contains_key(button) =>
                {
                    return Err(profile_error(
                        "mouse.ads_activation must reference an existing mouse binding",
                    ));
                }
                AdsActivation::Key { code } => validate_key_code(code)?,
                AdsActivation::MouseButton { button } if *button > 4 => {
                    return Err(profile_error("ADS mouse button source must be 0-4"));
                }
                AdsActivation::MouseButton { .. } => {}
            }
        }
        validate_game_associations(&self.game_associations)
    }
}

fn validate_mouse_settings(
    settings: &MouseSettings,
    path: &str,
) -> Result<(), ProfileValidationError> {
    validate_number(
        settings.sensitivity_x,
        0.001,
        0.2,
        &format!("{path}.sensitivity_x"),
    )?;
    validate_number(
        settings.sensitivity_y,
        0.001,
        0.2,
        &format!("{path}.sensitivity_y"),
    )?;
    validate_number(settings.deadzone, 0.0, 0.95, &format!("{path}.deadzone"))?;
    validate_number(settings.smoothing, 0.0, 0.95, &format!("{path}.smoothing"))?;
    validate_number(
        settings.velocity_scale,
        0.0,
        4.0,
        &format!("{path}.velocity_scale"),
    )
}

fn validate_game_associations(
    associations: &[GameAssociation],
) -> Result<(), ProfileValidationError> {
    if associations.len() > 20 {
        return Err(profile_error("game_associations exceeds 20 entries"));
    }
    let mut title_ids = HashSet::new();
    for association in associations {
        let bytes = association.title_id.as_bytes();
        if !(1..=80).contains(&bytes.len())
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.iter().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(profile_error("game title id is not normalized"));
        }
        if !title_ids.insert(&association.title_id) {
            return Err(profile_error("game title ids must be unique"));
        }
        validate_game_name(&association.title_name)?;
        if association.aliases.len() > 10 {
            return Err(profile_error("game aliases exceeds 10 entries"));
        }
        let mut aliases = HashSet::new();
        for alias in &association.aliases {
            validate_game_name(alias)?;
            if alias == &association.title_name || !aliases.insert(alias) {
                return Err(profile_error("game aliases must be unique"));
            }
        }
    }
    Ok(())
}

fn validate_game_name(value: &str) -> Result<(), ProfileValidationError> {
    if value.is_empty()
        || value.encode_utf16().count() > 100
        || value.trim() != value
        || value.to_lowercase() != value
        || !value.nfkc().eq(value.chars())
        || value.split_whitespace().collect::<Vec<_>>().join(" ") != value
    {
        return Err(profile_error(
            "game names and aliases must be normalized lowercase text",
        ));
    }
    Ok(())
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
        validate_key_code(source)?;
        validate_targets(targets)?;
    }
    Ok(())
}

fn validate_key_code(source: &str) -> Result<(), ProfileValidationError> {
    let mut characters = source.chars();
    if source.len() > 64
        || !characters
            .next()
            .is_some_and(|value| value.is_ascii_alphabetic())
        || !characters.all(|value| value.is_ascii_alphanumeric())
    {
        return Err(profile_error("invalid keyboard source"));
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
    previous_mouse: (f64, f64),
    previous_mode: Option<MouseMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseMode {
    Hip,
    Ads,
}

impl Mapper {
    #[must_use]
    pub fn new(profile: Profile) -> Self {
        Self {
            profile,
            pressed_keys: HashSet::new(),
            pressed_mouse_buttons: HashSet::new(),
            previous_mouse: (0.0, 0.0),
            previous_mode: None,
        }
    }

    pub fn replace_profile(&mut self, profile: Profile) {
        self.reset();
        self.profile = profile;
    }

    pub fn reset(&mut self) {
        self.pressed_keys.clear();
        self.pressed_mouse_buttons.clear();
        self.reset_mouse();
    }

    #[must_use]
    pub fn apply_batch(&mut self, events: &[InputEvent]) -> ControllerState {
        let mut mouse_dx = 0_i32;
        let mut mouse_dy = 0_i32;
        let mut mouse_mode = self.mouse_mode();
        let mut movements = Vec::new();

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
            let next_mode = self.mouse_mode();
            if next_mode != mouse_mode {
                movements.push((mouse_mode, mouse_dx, mouse_dy));
                mouse_dx = 0;
                mouse_dy = 0;
                mouse_mode = next_mode;
            }
        }
        if mouse_dx != 0 || mouse_dy != 0 {
            movements.push((mouse_mode, mouse_dx, mouse_dy));
        }

        self.build_state(&movements)
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

    fn build_state(&mut self, movements: &[(MouseMode, i32, i32)]) -> ControllerState {
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
        let (right_x, right_y) = self.mouse_axes(movements);
        state.right_x = stick_axis(right_x);
        state.right_y = stick_axis(right_y);
        state
    }

    fn mouse_mode(&self) -> MouseMode {
        match &self.profile.mouse.ads_activation {
            Some(AdsActivation::Key { code }) if self.pressed_keys.contains(code) => MouseMode::Ads,
            Some(AdsActivation::MouseButton { button }) => {
                if self.pressed_mouse_buttons.contains(button) {
                    MouseMode::Ads
                } else {
                    MouseMode::Hip
                }
            }
            Some(AdsActivation::Key { .. }) | None => MouseMode::Hip,
        }
    }

    fn mouse_axes(&mut self, movements: &[(MouseMode, i32, i32)]) -> (f64, f64) {
        if movements.is_empty() {
            self.reset_mouse();
            return (0.0, 0.0);
        }
        let mut combined = (0.0_f64, 0.0_f64);
        for &(mode, dx, dy) in movements {
            let output = self.mouse_segment(dx, dy, mode);
            combined.0 = (combined.0 + output.0).clamp(-1.0, 1.0);
            combined.1 = (combined.1 + output.1).clamp(-1.0, 1.0);
        }
        combined
    }

    fn mouse_segment(&mut self, dx: i32, dy: i32, mode: MouseMode) -> (f64, f64) {
        if self.previous_mode != Some(mode) {
            self.previous_mouse = (0.0, 0.0);
        }
        self.previous_mode = Some(mode);
        let settings = match mode {
            MouseMode::Hip => self.profile.mouse.hip.clone(),
            MouseMode::Ads => self.profile.mouse.ads.clone(),
        };
        let target_x = mouse_axis(
            dx,
            settings.sensitivity_x,
            settings.invert_x,
            settings.deadzone,
            settings.curve,
            settings.velocity_scale,
        );
        let target_y = mouse_axis(
            dy,
            settings.sensitivity_y,
            !settings.invert_y,
            settings.deadzone,
            settings.curve,
            settings.velocity_scale,
        );
        let output = (
            smooth_axis(target_x, self.previous_mouse.0, settings.smoothing, dx != 0),
            smooth_axis(target_y, self.previous_mouse.1, settings.smoothing, dy != 0),
        );
        self.previous_mouse = output;
        output
    }

    fn reset_mouse(&mut self) {
        self.previous_mouse = (0.0, 0.0);
        self.previous_mode = None;
    }
}

fn digital_axis(negative: bool, positive: bool) -> i16 {
    match (negative, positive) {
        (true, false) => i16::MIN,
        (false, true) => i16::MAX,
        _ => 0,
    }
}

fn mouse_axis(
    delta: i32,
    sensitivity: f32,
    invert: bool,
    deadzone: f32,
    curve: ResponseCurve,
    velocity_scale: f32,
) -> f64 {
    if delta == 0 || !sensitivity.is_finite() || sensitivity <= 0.0 {
        return 0.0;
    }
    let direction = if invert { -1.0_f64 } else { 1.0_f64 };
    let velocity_multiplier =
        1.0 + f64::from(velocity_scale.clamp(0.0, 4.0)) * (f64::from(delta).abs() / 100.0).min(1.0);
    let normalized = (f64::from(delta) * f64::from(sensitivity) * velocity_multiplier * direction)
        .clamp(-1.0, 1.0);
    let deadzone = f64::from(deadzone.clamp(0.0, 0.95));
    let scaled = if normalized.abs() <= deadzone {
        0.0
    } else {
        normalized.signum() * ((normalized.abs() - deadzone) / (1.0 - deadzone))
    };
    scaled.signum()
        * match curve {
            ResponseCurve::Linear => scaled.abs(),
            ResponseCurve::Exponential => scaled.abs().powi(2),
            ResponseCurve::Precision => scaled.abs().powi(3),
        }
}

fn smooth_axis(target: f64, previous: f64, smoothing: f32, moved: bool) -> f64 {
    if !moved || target == 0.0 {
        return 0.0;
    }
    let factor = f64::from(smoothing.clamp(0.0, 0.95));
    if factor == 0.0 || previous == 0.0 {
        target
    } else {
        (previous * factor + target * (1.0 - factor)).clamp(-1.0, 1.0)
    }
}

#[allow(clippy::cast_possible_truncation)]
fn stick_axis(value: f64) -> i16 {
    (value * f64::from(i16::MAX)).round() as i16
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
            profile.mouse.hip.invert_y = invert_y;
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
        profile.mouse.hip.sensitivity_x = 0.201;
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
        let linear = stick_axis(mouse_axis(25, 0.02, false, 0.0, ResponseCurve::Linear, 0.0));
        let exponential = stick_axis(mouse_axis(
            25,
            0.02,
            false,
            0.0,
            ResponseCurve::Exponential,
            0.0,
        ));
        let precision = stick_axis(mouse_axis(
            25,
            0.02,
            false,
            0.0,
            ResponseCurve::Precision,
            0.0,
        ));
        assert_eq!(linear, 16_383);
        assert_eq!(exponential, 8_192);
        assert_eq!(precision, 4_096);
    }

    #[test]
    fn switches_ads_response_while_configured_source_is_held() {
        let mut profile = Profile::default();
        profile.mouse.hip.sensitivity_x = 0.01;
        profile.mouse.ads.sensitivity_x = 0.02;
        profile.mouse.ads_activation = Some(AdsActivation::MouseButton { button: 2 });
        let mut mapper = Mapper::new(profile);
        let hip = mapper.apply_batch(&[InputEvent::MouseMove { dx: 10, dy: 0 }]);
        let ads = mapper.apply_batch(&[
            InputEvent::MouseButton {
                button: 2,
                down: true,
            },
            InputEvent::MouseMove { dx: 10, dy: 0 },
        ]);
        assert_eq!(hip.right_x, 3_277);
        assert_eq!(ads.right_x, 6_553);
    }

    #[test]
    fn applies_each_response_to_movement_in_event_order() {
        let mut profile = Profile::default();
        profile.mouse.hip.sensitivity_x = 0.01;
        profile.mouse.ads.sensitivity_x = 0.02;
        profile.mouse.ads_activation = Some(AdsActivation::MouseButton { button: 2 });
        let mut mapper = Mapper::new(profile);
        let state = mapper.apply_batch(&[
            InputEvent::MouseMove { dx: 10, dy: 0 },
            InputEvent::MouseButton {
                button: 2,
                down: true,
            },
            InputEvent::MouseMove { dx: 10, dy: 0 },
        ]);
        assert_eq!(state.right_x, 9_830);
    }

    #[test]
    fn smoothing_is_deterministic_but_empty_batches_neutralize_immediately() {
        let mut profile = Profile::default();
        profile.mouse.hip.sensitivity_x = 0.01;
        profile.mouse.hip.smoothing = 0.5;
        let mut mapper = Mapper::new(profile);
        assert_eq!(
            mapper
                .apply_batch(&[InputEvent::MouseMove { dx: 10, dy: 0 }])
                .right_x,
            3_277
        );
        assert_eq!(
            mapper
                .apply_batch(&[InputEvent::MouseMove { dx: 20, dy: 0 }])
                .right_x,
            4_915
        );
        assert_eq!(mapper.apply_batch(&[]).right_x, 0);
        assert_eq!(
            mapper
                .apply_batch(&[InputEvent::MouseMove { dx: 20, dy: 0 }])
                .right_x,
            6_553
        );
    }

    #[test]
    fn ads_transitions_without_movement_reset_smoothing() {
        let mut profile = Profile::default();
        profile.mouse.hip.sensitivity_x = 0.01;
        profile.mouse.hip.smoothing = 0.5;
        profile.mouse.ads_activation = Some(AdsActivation::MouseButton { button: 2 });
        let mut mapper = Mapper::new(profile);
        assert_eq!(
            mapper
                .apply_batch(&[InputEvent::MouseMove { dx: 10, dy: 0 }])
                .right_x,
            3_277
        );
        assert_eq!(
            mapper
                .apply_batch(&[
                    InputEvent::MouseButton {
                        button: 2,
                        down: true,
                    },
                    InputEvent::MouseButton {
                        button: 2,
                        down: false,
                    },
                    InputEvent::MouseMove { dx: 20, dy: 0 },
                ])
                .right_x,
            6_553
        );
    }

    #[test]
    fn v2_profile_json_contains_advanced_fields_and_rejects_unknown_fields() {
        let value = serde_json::to_value(Profile::default()).unwrap();
        assert_eq!(value["mouse"]["hip"]["smoothing"], 0.0);
        assert_eq!(value["mouse"]["ads"]["velocity_scale"], 0.0);
        assert_eq!(value["game_associations"], serde_json::json!([]));

        let mut invalid = value;
        invalid["mouse"]["hip"]["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Profile>(invalid).is_err());
    }

    #[test]
    fn rejects_non_nfkc_game_names() {
        let mut profile = Profile::default();
        profile.game_associations.push(GameAssociation {
            title_id: "cafe".into(),
            title_name: "cafe\u{301}".into(),
            aliases: Vec::new(),
        });
        assert!(profile.validate().is_err());
    }
}
