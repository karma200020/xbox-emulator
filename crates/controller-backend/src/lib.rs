use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ControllerState {
    pub buttons: u16,
    pub left_x: i16,
    pub left_y: i16,
    pub right_x: i16,
    pub right_y: i16,
    pub left_trigger: u8,
    pub right_trigger: u8,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BackendError {
    #[error("controller backend is unavailable: {0}")]
    Unavailable(String),
    #[error("controller backend rejected an update: {0}")]
    Update(String),
}

pub trait ControllerBackend {
    fn name(&self) -> &'static str;

    /// Connects to the backend and creates its virtual controller.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend or its required driver is unavailable.
    fn connect(&mut self) -> Result<(), BackendError>;

    /// Publishes a complete controller state.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend rejects or cannot deliver the update.
    fn update(&mut self, state: ControllerState) -> Result<(), BackendError>;

    /// Neutralizes and removes the virtual controller.
    ///
    /// # Errors
    ///
    /// Returns an error when neutralization or removal fails.
    fn disconnect(&mut self) -> Result<(), BackendError>;
}

#[derive(Debug, Clone, Default)]
pub struct FakeBackend {
    connected: bool,
    state: Arc<Mutex<ControllerState>>,
}

impl FakeBackend {
    #[must_use]
    pub fn shared_state(&self) -> Arc<Mutex<ControllerState>> {
        Arc::clone(&self.state)
    }
}

impl ControllerBackend for FakeBackend {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn connect(&mut self) -> Result<(), BackendError> {
        self.connected = true;
        Ok(())
    }

    fn update(&mut self, state: ControllerState) -> Result<(), BackendError> {
        if !self.connected {
            return Err(BackendError::Unavailable("not connected".into()));
        }
        *self
            .state
            .lock()
            .map_err(|_| BackendError::Update("state lock poisoned".into()))? = state;
        Ok(())
    }

    fn disconnect(&mut self) -> Result<(), BackendError> {
        if self.connected {
            self.update(ControllerState::default())?;
            self.connected = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_neutralizes_state() {
        let mut backend = FakeBackend::default();
        let state = backend.shared_state();
        backend.connect().unwrap();
        backend
            .update(ControllerState {
                buttons: 1,
                ..ControllerState::default()
            })
            .unwrap();
        backend.disconnect().unwrap();
        assert_eq!(*state.lock().unwrap(), ControllerState::default());
    }
}
