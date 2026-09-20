#![forbid(unsafe_code)]

use std::collections::{BTreeSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Generation(u64);

impl Generation {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct EventSequence(u64);

impl EventSequence {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DeviceInstanceId(u64);

impl DeviceInstanceId {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetIdentity {
    application: String,
    instance: u128,
    session: u64,
}

impl TargetIdentity {
    #[must_use]
    pub fn new(application: impl Into<String>, instance: u128, session: u64) -> Self {
        Self {
            application: application.into(),
            instance,
            session,
        }
    }

    #[must_use]
    pub fn application(&self) -> &str {
        &self.application
    }

    #[must_use]
    pub const fn instance(&self) -> u128 {
        self.instance
    }

    #[must_use]
    pub const fn session(&self) -> u64 {
        self.session
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinatorState {
    Inactive,
    Armed,
    Active,
    Deactivating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeOwner {
    Unowned,
    LocalInput,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeactivationReason {
    Requested,
    FocusLost,
    TargetExited,
    DeviceRemoved,
    SessionUnavailable,
    SessionChanged,
    DesktopUnavailable,
    Suspending,
    PowerTransition,
    OutputUnhealthy,
    InputOverload,
    SequenceGap,
    InvalidInput,
    EmergencyRelease,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    DropQueuedInput { invalidated_generation: Generation },
    ClearHeldState { invalidated_generation: Generation },
    NeutralizeOutput { invalidated_generation: Generation },
    ReleaseSuppression { invalidated_generation: Generation },
    DestroyOutput { invalidated_generation: Generation },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Connected,
    Disconnected,
    Locked,
    Unlocked,
    Logon,
    Logoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerEvent {
    Suspend,
    Resume,
    DisplayUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEvent {
    ForegroundChanged(Option<TargetIdentity>),
    DeviceArrived(DeviceInstanceId),
    DeviceRemoved(DeviceInstanceId),
    Session(SessionEvent),
    DefaultDesktopAvailable(bool),
    Power(PowerEvent),
    TargetExited,
    OutputHealthy(bool),
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRecord<T> {
    pub generation: Generation,
    pub sequence: EventSequence,
    pub event: T,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    Key { code: u16, pressed: bool },
    Button { button: u8, pressed: bool },
    RelativeMotion { dx: i32, dy: i32 },
    Wheel { horizontal: bool, delta: i16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputRecord {
    pub generation: Generation,
    pub sequence: EventSequence,
    pub device: DeviceInstanceId,
    pub event: InputEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    StaleGeneration,
    Inactive,
    UnknownDevice,
    NonMonotonicSequence,
    SequenceGap,
    QueueFull,
    OutOfBounds,
    EmergencyLatched,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputDisposition {
    Accepted,
    Rejected(Rejection),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputOutcome {
    pub disposition: InputDisposition,
    pub commands: Vec<Command>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionError {
    ModeOwned(ModeOwner),
    LocalModeNotOwned,
    InvalidState(CoordinatorState),
    StaleGeneration,
    PrerequisitesNotMet,
    EmergencyLatched,
    NoDevices,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoordinatorConfig {
    pub input_capacity: usize,
    pub max_relative_delta: i32,
}

impl CoordinatorConfig {
    #[must_use]
    pub const fn new(input_capacity: usize, max_relative_delta: i32) -> Self {
        Self {
            input_capacity,
            max_relative_delta,
        }
    }
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self::new(256, 32_767)
    }
}

#[derive(Debug)]
pub struct LocalInputCoordinator {
    config: CoordinatorConfig,
    state: CoordinatorState,
    mode_owner: ModeOwner,
    generation: Generation,
    target: Option<TargetIdentity>,
    devices: BTreeSet<DeviceInstanceId>,
    input: VecDeque<InputRecord>,
    next_input_sequence: EventSequence,
    last_lifecycle_sequence: Option<EventSequence>,
    last_priority_sequence: Option<EventSequence>,
    foreground: bool,
    health: ActivationHealth,
    emergency_latched: bool,
    deactivation_reason: Option<DeactivationReason>,
    cleanup: CleanupStatus,
}

#[derive(Debug)]
struct ActivationHealth {
    session_available: bool,
    default_desktop: bool,
    output_healthy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum OutputCleanup {
    #[default]
    Complete,
    NeutralPending,
    DestroyPending,
}

#[derive(Debug, Default)]
struct CleanupStatus {
    output: OutputCleanup,
    suppression_release_pending: bool,
}

impl LocalInputCoordinator {
    #[must_use]
    pub fn new(config: CoordinatorConfig) -> Self {
        Self {
            config,
            state: CoordinatorState::Inactive,
            mode_owner: ModeOwner::Unowned,
            generation: Generation(0),
            target: None,
            devices: BTreeSet::new(),
            input: VecDeque::with_capacity(config.input_capacity),
            next_input_sequence: EventSequence(1),
            last_lifecycle_sequence: None,
            last_priority_sequence: None,
            foreground: false,
            health: ActivationHealth {
                session_available: true,
                default_desktop: true,
                output_healthy: true,
            },
            emergency_latched: false,
            deactivation_reason: None,
            cleanup: CleanupStatus::default(),
        }
    }

    #[must_use]
    pub const fn state(&self) -> CoordinatorState {
        self.state
    }

    #[must_use]
    pub const fn mode_owner(&self) -> ModeOwner {
        self.mode_owner
    }

    #[must_use]
    pub const fn generation(&self) -> Generation {
        self.generation
    }

    #[must_use]
    pub fn target(&self) -> Option<&TargetIdentity> {
        self.target.as_ref()
    }

    #[must_use]
    pub const fn emergency_latched(&self) -> bool {
        self.emergency_latched
    }

    #[must_use]
    pub const fn deactivation_reason(&self) -> Option<DeactivationReason> {
        self.deactivation_reason
    }

    #[must_use]
    pub fn queued_input_len(&self) -> usize {
        self.input.len()
    }

    /// Claims exclusive ownership of the input mode.
    ///
    /// # Errors
    ///
    /// Returns [`TransitionError::ModeOwned`] when the other mode owns it.
    pub fn claim_mode(&mut self, owner: ModeOwner) -> Result<(), TransitionError> {
        if owner == ModeOwner::Unowned {
            return self.release_mode();
        }
        if self.mode_owner == ModeOwner::Unowned || self.mode_owner == owner {
            self.mode_owner = owner;
            Ok(())
        } else {
            Err(TransitionError::ModeOwned(self.mode_owner))
        }
    }

    /// Releases mode ownership while inactive.
    ///
    /// # Errors
    ///
    /// Returns [`TransitionError::InvalidState`] before cleanup is complete.
    pub fn release_mode(&mut self) -> Result<(), TransitionError> {
        if self.state != CoordinatorState::Inactive {
            return Err(TransitionError::InvalidState(self.state));
        }
        self.mode_owner = ModeOwner::Unowned;
        Ok(())
    }

    /// Binds a fresh generation to an immutable target and device set.
    ///
    /// # Errors
    ///
    /// Returns an error unless local mode is owned, the coordinator is inactive,
    /// at least one device exists, and any emergency latch is acknowledged.
    pub fn arm(
        &mut self,
        target: TargetIdentity,
        devices: impl IntoIterator<Item = DeviceInstanceId>,
    ) -> Result<Generation, TransitionError> {
        if self.mode_owner != ModeOwner::LocalInput {
            return Err(TransitionError::LocalModeNotOwned);
        }
        if self.emergency_latched {
            return Err(TransitionError::EmergencyLatched);
        }
        if self.state != CoordinatorState::Inactive {
            return Err(TransitionError::InvalidState(self.state));
        }
        let devices: BTreeSet<_> = devices.into_iter().collect();
        if devices.is_empty() {
            return Err(TransitionError::NoDevices);
        }

        self.generation = Generation(self.generation.0.saturating_add(1));
        self.target = Some(target);
        self.devices = devices;
        self.input.clear();
        self.next_input_sequence = EventSequence(1);
        self.last_lifecycle_sequence = None;
        self.last_priority_sequence = None;
        self.foreground = false;
        self.deactivation_reason = None;
        self.state = CoordinatorState::Armed;
        Ok(self.generation)
    }

    /// Activates an armed generation after all adapter-verified checks pass.
    ///
    /// # Errors
    ///
    /// Returns an error for a stale generation, wrong state, or failed prerequisite.
    pub fn activate(&mut self, generation: Generation) -> Result<(), TransitionError> {
        self.require_generation(generation)?;
        if self.state != CoordinatorState::Armed {
            return Err(TransitionError::InvalidState(self.state));
        }
        if !self.foreground
            || !self.health.session_available
            || !self.health.default_desktop
            || !self.health.output_healthy
        {
            return Err(TransitionError::PrerequisitesNotMet);
        }
        self.state = CoordinatorState::Active;
        Ok(())
    }

    pub fn handle_lifecycle(&mut self, record: EventRecord<LifecycleEvent>) -> Vec<Command> {
        if record.generation != self.generation {
            return Vec::new();
        }
        if self
            .last_lifecycle_sequence
            .is_some_and(|last| record.sequence <= last)
        {
            return Vec::new();
        }
        self.last_lifecycle_sequence = Some(record.sequence);

        match record.event {
            LifecycleEvent::ForegroundChanged(identity) => {
                self.foreground = identity.as_ref() == self.target.as_ref();
                if !self.foreground && self.state == CoordinatorState::Active {
                    return self.begin_deactivation(DeactivationReason::FocusLost);
                }
            }
            LifecycleEvent::DeviceArrived(device) => {
                self.devices.insert(device);
            }
            LifecycleEvent::DeviceRemoved(device) => {
                if self.devices.remove(&device)
                    && matches!(
                        self.state,
                        CoordinatorState::Armed | CoordinatorState::Active
                    )
                {
                    return self.begin_deactivation(DeactivationReason::DeviceRemoved);
                }
            }
            LifecycleEvent::Session(event) => {
                self.health.session_available = matches!(
                    event,
                    SessionEvent::Connected | SessionEvent::Unlocked | SessionEvent::Logon
                );
                if matches!(
                    self.state,
                    CoordinatorState::Armed | CoordinatorState::Active
                ) {
                    let reason = if self.health.session_available {
                        DeactivationReason::SessionChanged
                    } else {
                        DeactivationReason::SessionUnavailable
                    };
                    return self.begin_deactivation(reason);
                }
            }
            LifecycleEvent::DefaultDesktopAvailable(available) => {
                self.health.default_desktop = available;
                if !available {
                    return self.begin_deactivation(DeactivationReason::DesktopUnavailable);
                }
            }
            LifecycleEvent::Power(event) => {
                let reason =
                    if matches!(event, PowerEvent::Suspend | PowerEvent::DisplayUnavailable) {
                        DeactivationReason::Suspending
                    } else {
                        DeactivationReason::PowerTransition
                    };
                self.devices.clear();
                if matches!(
                    self.state,
                    CoordinatorState::Armed | CoordinatorState::Active
                ) {
                    return self.begin_deactivation(reason);
                }
            }
            LifecycleEvent::TargetExited => {
                return self.begin_deactivation(DeactivationReason::TargetExited);
            }
            LifecycleEvent::OutputHealthy(healthy) => {
                self.health.output_healthy = healthy;
                if !healthy {
                    return self.begin_deactivation(DeactivationReason::OutputUnhealthy);
                }
            }
            LifecycleEvent::Stop => {
                return self.begin_deactivation(DeactivationReason::Requested);
            }
        }
        Vec::new()
    }

    pub fn accept_input(&mut self, record: InputRecord) -> InputOutcome {
        if record.generation != self.generation {
            return InputOutcome::rejected(Rejection::StaleGeneration);
        }
        if self.state != CoordinatorState::Active {
            return InputOutcome::rejected(Rejection::Inactive);
        }
        if !self.devices.contains(&record.device) {
            return InputOutcome::rejected(Rejection::UnknownDevice);
        }
        if record.sequence < self.next_input_sequence {
            return InputOutcome::rejected(Rejection::NonMonotonicSequence);
        }
        if record.sequence > self.next_input_sequence {
            let commands = self.begin_deactivation(DeactivationReason::SequenceGap);
            return InputOutcome::rejected_with(Rejection::SequenceGap, commands);
        }
        if !self.input_in_bounds(record.event) {
            let commands = self.begin_deactivation(DeactivationReason::InvalidInput);
            return InputOutcome::rejected_with(Rejection::OutOfBounds, commands);
        }
        if self.input.len() >= self.config.input_capacity {
            let commands = self.begin_deactivation(DeactivationReason::InputOverload);
            return InputOutcome::rejected_with(Rejection::QueueFull, commands);
        }
        self.next_input_sequence = EventSequence(self.next_input_sequence.0.saturating_add(1));
        self.input.push_back(record);
        InputOutcome {
            disposition: InputDisposition::Accepted,
            commands: Vec::new(),
        }
    }

    pub fn drain_input(&mut self, limit: usize) -> Vec<InputRecord> {
        let count = limit.min(self.input.len());
        self.input.drain(..count).collect()
    }

    pub fn emergency_release(
        &mut self,
        generation: Generation,
        sequence: EventSequence,
    ) -> InputOutcome {
        if generation != self.generation {
            return InputOutcome::rejected(Rejection::StaleGeneration);
        }
        if self
            .last_priority_sequence
            .is_some_and(|last| sequence <= last)
        {
            return InputOutcome::rejected(Rejection::NonMonotonicSequence);
        }
        self.last_priority_sequence = Some(sequence);
        self.emergency_latched = true;
        let commands = self.begin_deactivation(DeactivationReason::EmergencyRelease);
        InputOutcome {
            disposition: InputDisposition::Accepted,
            commands,
        }
    }

    pub fn acknowledge_emergency(&mut self) {
        self.emergency_latched = false;
    }

    pub fn acknowledge_neutralized(&mut self) {
        if self.state == CoordinatorState::Deactivating
            && self.cleanup.output == OutputCleanup::NeutralPending
        {
            self.cleanup.output = OutputCleanup::Complete;
            self.finish_deactivation_if_ready();
        }
    }

    pub fn neutralization_failed(&mut self) -> Vec<Command> {
        if self.state == CoordinatorState::Deactivating
            && self.cleanup.output == OutputCleanup::NeutralPending
        {
            self.cleanup.output = OutputCleanup::DestroyPending;
            return vec![Command::DestroyOutput {
                invalidated_generation: Generation(self.generation.0.saturating_sub(1)),
            }];
        }
        Vec::new()
    }

    pub fn acknowledge_output_destroyed(&mut self) {
        if self.state == CoordinatorState::Deactivating
            && self.cleanup.output == OutputCleanup::DestroyPending
        {
            self.cleanup.output = OutputCleanup::Complete;
            self.finish_deactivation_if_ready();
        }
    }

    pub fn acknowledge_suppression_released(&mut self) {
        if self.state == CoordinatorState::Deactivating {
            self.cleanup.suppression_release_pending = false;
            self.finish_deactivation_if_ready();
        }
    }

    fn require_generation(&self, generation: Generation) -> Result<(), TransitionError> {
        if generation == self.generation {
            Ok(())
        } else {
            Err(TransitionError::StaleGeneration)
        }
    }

    fn input_in_bounds(&self, event: InputEvent) -> bool {
        match event {
            InputEvent::RelativeMotion { dx, dy } => {
                dx.unsigned_abs() <= self.config.max_relative_delta.unsigned_abs()
                    && dy.unsigned_abs() <= self.config.max_relative_delta.unsigned_abs()
            }
            InputEvent::Key { .. } | InputEvent::Button { .. } | InputEvent::Wheel { .. } => true,
        }
    }

    fn begin_deactivation(&mut self, reason: DeactivationReason) -> Vec<Command> {
        if matches!(
            self.state,
            CoordinatorState::Inactive | CoordinatorState::Deactivating
        ) {
            return Vec::new();
        }
        let invalidated_generation = self.generation;
        self.generation = Generation(self.generation.0.saturating_add(1));
        self.state = CoordinatorState::Deactivating;
        self.foreground = false;
        self.input.clear();
        self.devices.clear();
        self.deactivation_reason = Some(reason);
        self.cleanup.output = OutputCleanup::NeutralPending;
        self.cleanup.suppression_release_pending = true;
        vec![
            Command::DropQueuedInput {
                invalidated_generation,
            },
            Command::ClearHeldState {
                invalidated_generation,
            },
            Command::NeutralizeOutput {
                invalidated_generation,
            },
            Command::ReleaseSuppression {
                invalidated_generation,
            },
        ]
    }

    fn finish_deactivation_if_ready(&mut self) {
        if self.cleanup.output == OutputCleanup::Complete
            && !self.cleanup.suppression_release_pending
        {
            self.state = CoordinatorState::Inactive;
            self.target = None;
        }
    }
}

impl InputOutcome {
    fn rejected(rejection: Rejection) -> Self {
        Self::rejected_with(rejection, Vec::new())
    }

    fn rejected_with(rejection: Rejection, commands: Vec<Command>) -> Self {
        Self {
            disposition: InputDisposition::Rejected(rejection),
            commands,
        }
    }
}

pub trait LocalInputEventSink {
    fn lifecycle(&mut self, event: EventRecord<LifecycleEvent>) -> Vec<Command>;
    fn input(&mut self, event: InputRecord) -> InputOutcome;
    fn emergency(&mut self, generation: Generation, sequence: EventSequence) -> InputOutcome;
}

impl LocalInputEventSink for LocalInputCoordinator {
    fn lifecycle(&mut self, event: EventRecord<LifecycleEvent>) -> Vec<Command> {
        self.handle_lifecycle(event)
    }

    fn input(&mut self, event: InputRecord) -> InputOutcome {
        self.accept_input(event)
    }

    fn emergency(&mut self, generation: Generation, sequence: EventSequence) -> InputOutcome {
        self.emergency_release(generation, sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: DeviceInstanceId = DeviceInstanceId::new(7);

    fn target(instance: u128) -> TargetIdentity {
        TargetIdentity::new("stable-app-id", instance, 3)
    }

    fn armed(capacity: usize) -> (LocalInputCoordinator, Generation, TargetIdentity) {
        let mut coordinator = LocalInputCoordinator::new(CoordinatorConfig::new(capacity, 100));
        coordinator.claim_mode(ModeOwner::LocalInput).unwrap();
        let target = target(11);
        let generation = coordinator.arm(target.clone(), [DEVICE]).unwrap();
        (coordinator, generation, target)
    }

    fn active(capacity: usize) -> (LocalInputCoordinator, Generation) {
        let (mut coordinator, generation, target) = armed(capacity);
        coordinator.handle_lifecycle(EventRecord {
            generation,
            sequence: EventSequence::new(1),
            event: LifecycleEvent::ForegroundChanged(Some(target)),
        });
        coordinator.activate(generation).unwrap();
        (coordinator, generation)
    }

    fn input(generation: Generation, sequence: u64) -> InputRecord {
        InputRecord {
            generation,
            sequence: EventSequence::new(sequence),
            device: DEVICE,
            event: InputEvent::Key {
                code: 1,
                pressed: true,
            },
        }
    }

    fn finish_deactivation(coordinator: &mut LocalInputCoordinator) {
        coordinator.acknowledge_neutralized();
        coordinator.acknowledge_suppression_released();
    }

    #[test]
    fn transition_path_requires_foreground_and_fresh_explicit_activation() {
        let (mut coordinator, generation, selected) = armed(4);
        assert_eq!(coordinator.state(), CoordinatorState::Armed);
        assert_eq!(
            coordinator.activate(generation),
            Err(TransitionError::PrerequisitesNotMet)
        );
        coordinator.handle_lifecycle(EventRecord {
            generation,
            sequence: EventSequence::new(1),
            event: LifecycleEvent::ForegroundChanged(Some(selected.clone())),
        });
        coordinator.activate(generation).unwrap();
        assert_eq!(coordinator.state(), CoordinatorState::Active);

        let commands = coordinator.handle_lifecycle(EventRecord {
            generation,
            sequence: EventSequence::new(2),
            event: LifecycleEvent::ForegroundChanged(Some(target(12))),
        });
        assert_eq!(commands.len(), 4);
        assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
        let invalidated = coordinator.generation();
        finish_deactivation(&mut coordinator);
        assert_eq!(coordinator.state(), CoordinatorState::Inactive);
        assert_eq!(
            coordinator.activate(generation),
            Err(TransitionError::StaleGeneration)
        );
        assert!(invalidated > generation);
    }

    #[test]
    fn target_identity_is_exact_and_immutable_during_activation() {
        let (coordinator, _, selected) = armed(4);
        assert_eq!(coordinator.target(), Some(&selected));
        assert_eq!(coordinator.target().unwrap().instance(), 11);
    }

    #[test]
    fn stale_and_non_monotonic_input_never_enters_queue() {
        let (mut coordinator, generation) = active(4);
        assert_eq!(
            coordinator
                .accept_input(input(Generation(0), 1))
                .disposition,
            InputDisposition::Rejected(Rejection::StaleGeneration)
        );
        assert_eq!(
            coordinator.accept_input(input(generation, 1)).disposition,
            InputDisposition::Accepted
        );
        assert_eq!(
            coordinator.accept_input(input(generation, 1)).disposition,
            InputDisposition::Rejected(Rejection::NonMonotonicSequence)
        );
        assert_eq!(coordinator.queued_input_len(), 1);
    }

    #[test]
    fn every_sequence_gap_deactivates() {
        for gap in 2..20 {
            let (mut coordinator, generation) = active(4);
            let outcome = coordinator.accept_input(input(generation, gap));
            assert_eq!(
                outcome.disposition,
                InputDisposition::Rejected(Rejection::SequenceGap)
            );
            assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
            assert_eq!(
                coordinator.deactivation_reason(),
                Some(DeactivationReason::SequenceGap)
            );
        }
    }

    #[test]
    fn every_capacity_is_bounded_and_overload_fails_closed() {
        for capacity in 0..16 {
            let (mut coordinator, generation) = active(capacity);
            for sequence in 1..=capacity {
                assert_eq!(
                    coordinator
                        .accept_input(input(generation, sequence as u64))
                        .disposition,
                    InputDisposition::Accepted
                );
            }
            let outcome = coordinator.accept_input(input(generation, capacity as u64 + 1));
            assert_eq!(
                outcome.disposition,
                InputDisposition::Rejected(Rejection::QueueFull)
            );
            assert_eq!(coordinator.queued_input_len(), 0);
            assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
        }
    }

    #[test]
    fn relative_motion_bounds_are_checked_without_overflow() {
        for delta in [101, i32::MAX, i32::MIN] {
            let (mut coordinator, generation) = active(2);
            let mut record = input(generation, 1);
            record.event = InputEvent::RelativeMotion { dx: delta, dy: 0 };
            assert_eq!(
                coordinator.accept_input(record).disposition,
                InputDisposition::Rejected(Rejection::OutOfBounds)
            );
            assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
        }
    }

    #[test]
    fn focus_loss_device_removal_and_suspend_all_fail_closed() {
        let cases = [
            (
                LifecycleEvent::ForegroundChanged(None),
                DeactivationReason::FocusLost,
            ),
            (
                LifecycleEvent::DeviceRemoved(DEVICE),
                DeactivationReason::DeviceRemoved,
            ),
            (
                LifecycleEvent::Power(PowerEvent::Suspend),
                DeactivationReason::Suspending,
            ),
        ];
        for (event, reason) in cases {
            let (mut coordinator, generation) = active(2);
            let commands = coordinator.handle_lifecycle(EventRecord {
                generation,
                sequence: EventSequence::new(2),
                event,
            });
            assert_eq!(commands.len(), 4);
            assert_eq!(coordinator.deactivation_reason(), Some(reason));
            assert_eq!(coordinator.queued_input_len(), 0);
        }
    }

    #[test]
    fn all_unavailable_session_events_deactivate() {
        for event in [
            SessionEvent::Disconnected,
            SessionEvent::Locked,
            SessionEvent::Logoff,
        ] {
            let (mut coordinator, generation) = active(2);
            coordinator.handle_lifecycle(EventRecord {
                generation,
                sequence: EventSequence::new(2),
                event: LifecycleEvent::Session(event),
            });
            assert_eq!(
                coordinator.deactivation_reason(),
                Some(DeactivationReason::SessionUnavailable)
            );
        }
    }

    #[test]
    fn every_session_change_and_power_transition_requires_reactivation() {
        for event in [
            LifecycleEvent::Session(SessionEvent::Connected),
            LifecycleEvent::Session(SessionEvent::Unlocked),
            LifecycleEvent::Session(SessionEvent::Logon),
            LifecycleEvent::Power(PowerEvent::Suspend),
            LifecycleEvent::Power(PowerEvent::Resume),
            LifecycleEvent::Power(PowerEvent::DisplayUnavailable),
        ] {
            let (mut coordinator, generation) = active(2);
            coordinator.handle_lifecycle(EventRecord {
                generation,
                sequence: EventSequence::new(2),
                event,
            });
            assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
            finish_deactivation(&mut coordinator);
            assert_eq!(coordinator.state(), CoordinatorState::Inactive);
        }
    }

    #[test]
    fn emergency_priority_bypasses_a_full_normal_queue_and_latches() {
        let (mut coordinator, generation) = active(2);
        assert_eq!(
            coordinator.accept_input(input(generation, 1)).disposition,
            InputDisposition::Accepted
        );
        assert_eq!(
            coordinator.accept_input(input(generation, 2)).disposition,
            InputDisposition::Accepted
        );
        let outcome = coordinator.emergency_release(generation, EventSequence::new(1));
        assert_eq!(outcome.disposition, InputDisposition::Accepted);
        assert_eq!(outcome.commands.len(), 4);
        assert!(coordinator.emergency_latched());
        finish_deactivation(&mut coordinator);
        assert_eq!(
            coordinator.arm(target(11), [DEVICE]),
            Err(TransitionError::EmergencyLatched)
        );
        coordinator.acknowledge_emergency();
        assert!(coordinator.arm(target(11), [DEVICE]).is_ok());
    }

    #[test]
    fn stale_emergency_cannot_release_a_new_generation() {
        let (mut coordinator, generation) = active(2);
        let outcome = coordinator.emergency_release(
            Generation(generation.value().saturating_sub(1)),
            EventSequence::new(1),
        );
        assert_eq!(
            outcome.disposition,
            InputDisposition::Rejected(Rejection::StaleGeneration)
        );
        assert_eq!(coordinator.state(), CoordinatorState::Active);
    }

    #[test]
    fn emergency_release_is_safe_and_latched_while_inactive() {
        let mut coordinator = LocalInputCoordinator::new(CoordinatorConfig::default());
        let outcome =
            coordinator.emergency_release(coordinator.generation(), EventSequence::new(1));
        assert_eq!(outcome.disposition, InputDisposition::Accepted);
        assert!(outcome.commands.is_empty());
        assert!(coordinator.emergency_latched());
        assert_eq!(coordinator.state(), CoordinatorState::Inactive);
    }

    #[test]
    fn neutralization_and_cleanup_are_idempotent() {
        let (mut coordinator, generation) = active(2);
        let first = coordinator.handle_lifecycle(EventRecord {
            generation,
            sequence: EventSequence::new(2),
            event: LifecycleEvent::Stop,
        });
        let repeated = coordinator.handle_lifecycle(EventRecord {
            generation: coordinator.generation(),
            sequence: EventSequence::new(3),
            event: LifecycleEvent::Stop,
        });
        assert_eq!(first.len(), 4);
        assert!(repeated.is_empty());
        coordinator.acknowledge_neutralized();
        coordinator.acknowledge_neutralized();
        coordinator.acknowledge_suppression_released();
        coordinator.acknowledge_suppression_released();
        assert_eq!(coordinator.state(), CoordinatorState::Inactive);
    }

    #[test]
    fn failed_neutralization_requests_destroy_once() {
        let (mut coordinator, generation) = active(2);
        coordinator.handle_lifecycle(EventRecord {
            generation,
            sequence: EventSequence::new(2),
            event: LifecycleEvent::Stop,
        });
        assert_eq!(coordinator.neutralization_failed().len(), 1);
        assert!(coordinator.neutralization_failed().is_empty());
        coordinator.acknowledge_suppression_released();
        assert_eq!(coordinator.state(), CoordinatorState::Deactivating);
        coordinator.acknowledge_output_destroyed();
        assert_eq!(coordinator.state(), CoordinatorState::Inactive);
    }

    #[test]
    fn local_and_external_modes_are_mutually_exclusive() {
        let mut coordinator = LocalInputCoordinator::new(CoordinatorConfig::default());
        coordinator.claim_mode(ModeOwner::External).unwrap();
        assert_eq!(
            coordinator.claim_mode(ModeOwner::LocalInput),
            Err(TransitionError::ModeOwned(ModeOwner::External))
        );
        assert_eq!(
            coordinator.arm(target(11), [DEVICE]),
            Err(TransitionError::LocalModeNotOwned)
        );
        coordinator.release_mode().unwrap();
        coordinator.claim_mode(ModeOwner::LocalInput).unwrap();
        coordinator.arm(target(11), [DEVICE]).unwrap();
        assert_eq!(
            coordinator.claim_mode(ModeOwner::External),
            Err(TransitionError::ModeOwned(ModeOwner::LocalInput))
        );
        assert!(coordinator.release_mode().is_err());
    }

    #[test]
    fn stale_lifecycle_events_do_not_mutate_current_activation() {
        let (mut coordinator, generation) = active(2);
        coordinator.handle_lifecycle(EventRecord {
            generation: Generation(generation.value().saturating_sub(1)),
            sequence: EventSequence::new(99),
            event: LifecycleEvent::Power(PowerEvent::Suspend),
        });
        assert_eq!(coordinator.state(), CoordinatorState::Active);
    }
}
