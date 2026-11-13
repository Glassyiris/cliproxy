//! Configuration-domain notifications owned by the same gate as persistence.
//! Credential grants and cooldown checkpoints do not enter this subscription.
use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Weak;

/// Initial delivery is separate from a successful committed-change event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigurationChange {
    Initial,
    Committed,
}

/// An immutable configuration projection for trusted configuration consumers.
/// Never includes canonical credential documents, metadata, cooldowns or history.
pub struct ConfigurationView {
    pub change: ConfigurationChange,
    pub revision: u64,
    pub digest: String,
    pub config: Arc<Config>,
}

type Callback = Arc<dyn Fn(Arc<ConfigurationView>) -> anyhow::Result<()> + Send + Sync>;

#[derive(Default)]
pub(super) struct Subscriptions {
    next: u64,
    callbacks: BTreeMap<u64, Callback>,
    installers: BTreeMap<u64, Callback>,
}

/// Removing the owner's handle unregisters its callback, without taking the
/// command gate. A callback already being dispatched may finish.
pub struct ConfigurationSubscription {
    subscriptions: Weak<Mutex<Subscriptions>>,
    id: u64,
    installer: bool,
}

impl Drop for ConfigurationSubscription {
    fn drop(&mut self) {
        if let Some(subscriptions) = self.subscriptions.upgrade() {
            let removed = {
                let mut subscriptions = subscriptions.lock().unwrap_or_else(PoisonError::into_inner);
                if self.installer {
                    subscriptions.installers.remove(&self.id)
                } else {
                    subscriptions.callbacks.remove(&self.id)
                }
            };
            // A capture can own another subscription on this same list.
            drop(removed);
        }
    }
}

thread_local! {
    static DISPATCHING: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

struct Dispatch(usize);
impl Drop for Dispatch {
    fn drop(&mut self) {
        DISPATCHING.with(|held| {
            assert_eq!(held.borrow_mut().pop(), Some(self.0));
        });
    }
}

impl ConfigStore {
    pub(crate) fn check_reentry(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !DISPATCHING.with(|held| held.borrow().contains(&(self as *const Self as usize))),
            "configuration callbacks cannot synchronously submit commands; schedule owned follow-up work"
        );
        Ok(())
    }

    fn invoke(&self, callback: &Callback, view: Arc<ConfigurationView>) -> anyhow::Result<()> {
        let identity = self as *const Self as usize;
        DISPATCHING.with(|held| held.borrow_mut().push(identity));
        let _dispatch = Dispatch(identity);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(view))) {
            Ok(result) => result.map_err(|_| anyhow::anyhow!("configuration projection failed")),
            Err(_) => Err(anyhow::anyhow!("configuration projection panicked")),
        }
    }

    fn notify(&self, callback: &Callback, view: Arc<ConfigurationView>) {
        // Ordinary observers cannot roll back durability or prevent later observers.
        // Never log callback inputs or arbitrary subscriber error text.
        if self.invoke(callback, view).is_err() {
            tracing::error!("configuration subscriber failed or panicked");
        }
    }

    pub(super) fn configuration_view(
        state: &State,
        change: ConfigurationChange,
    ) -> anyhow::Result<Arc<ConfigurationView>> {
        let (config, _) = resources::config(&state.resources).map_err(|fault| anyhow::anyhow!("{fault}"))?;
        Ok(Arc::new(ConfigurationView {
            change,
            revision: state.rev(),
            digest: public_digest(&state.resources),
            config: Arc::new(config),
        }))
    }

    /// Registers and delivers the initial immutable view under command admission,
    /// then delivers relevant accepted versions in order before commands return.
    /// Callbacks run without state/list locks. They may read or enqueue owned work,
    /// but must not synchronously submit commands (including registration).
    /// Callback errors/panics are reported separately and do not roll back state.
    pub fn subscribe_configuration(
        &self,
        callback: impl Fn(Arc<ConfigurationView>) -> anyhow::Result<()> + Send + Sync + 'static,
    ) -> anyhow::Result<ConfigurationSubscription> {
        self.register_configuration(Arc::new(callback), false)
    }

    /// Required runtime adapters install views before ordinary change dispatch.
    #[cfg(test)]
    pub(crate) fn install_configuration(
        &self,
        callback: impl Fn(Arc<ConfigurationView>) -> anyhow::Result<()> + Send + Sync + 'static,
    ) -> anyhow::Result<ConfigurationSubscription> {
        self.register_configuration(Arc::new(callback), true)
    }

    /// A trusted adapter and its ordinary success notification register together:
    /// no intervening command can leave the adapter bound without its notifier.
    pub(crate) fn install_configuration_and_notify(
        &self,
        install: impl Fn(Arc<ConfigurationView>) -> anyhow::Result<()> + Send + Sync + 'static,
        notify: impl Fn(Arc<ConfigurationView>) -> anyhow::Result<()> + Send + Sync + 'static,
    ) -> anyhow::Result<(ConfigurationSubscription, ConfigurationSubscription)> {
        let _writer = self.writer()?;
        let view = Self::configuration_view(&self.current(), ConfigurationChange::Initial)?;
        let installer = self.register_configuration_view(Arc::new(install), true, view.clone())?;
        let notification = self.register_configuration_view(Arc::new(notify), false, view)?;
        Ok((installer, notification))
    }

    fn register_configuration(&self, callback: Callback, installer: bool) -> anyhow::Result<ConfigurationSubscription> {
        let _writer = self.writer()?;
        let view = Self::configuration_view(&self.current(), ConfigurationChange::Initial)?;
        self.register_configuration_view(callback, installer, view)
    }

    fn register_configuration_view(
        &self,
        callback: Callback,
        installer: bool,
        view: Arc<ConfigurationView>,
    ) -> anyhow::Result<ConfigurationSubscription> {
        let id = {
            let mut subscriptions = self.subscriptions.lock().unwrap_or_else(PoisonError::into_inner);
            let id = subscriptions.next;
            subscriptions.next += 1;
            if installer {
                subscriptions.installers.insert(id, callback.clone());
            } else {
                subscriptions.callbacks.insert(id, callback.clone());
            }
            id
        };
        let subscription = ConfigurationSubscription {
            subscriptions: Arc::downgrade(&self.subscriptions),
            id,
            installer,
        };
        if installer {
            self.invoke(&callback, view)?;
        } else {
            self.notify(&callback, view);
        }
        Ok(subscription)
    }

    pub(super) fn dispatch_configuration(&self, view: Arc<ConfigurationView>) -> anyhow::Result<()> {
        let (installers, callbacks): (Vec<_>, Vec<_>) = {
            let subscriptions = self.subscriptions.lock().unwrap_or_else(PoisonError::into_inner);
            (
                subscriptions.installers.values().cloned().collect(),
                subscriptions.callbacks.values().cloned().collect(),
            )
        };
        for callback in installers {
            self.invoke(&callback, view.clone())?;
        }
        for callback in callbacks {
            self.notify(&callback, view.clone());
        }
        Ok(())
    }
}
