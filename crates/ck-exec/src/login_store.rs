//! Shared persistence contract for provider logins.
use std::path::PathBuf;

/// Wraps a provider login's final merge/write in its durable owner's file transaction.
pub type LoginSave =
    std::sync::Arc<dyn Fn(&[PathBuf], &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> + Send + Sync>;

pub fn save_login<T>(
    save: Option<&LoginSave>,
    paths: &[PathBuf],
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(save) = save else {
        return write();
    };
    let mut write = Some(write);
    let mut result = None;
    save(paths, &mut || {
        let write = write.take().ok_or("credential writer invoked twice")?;
        result = Some(write()?);
        Ok(())
    })?;
    result.ok_or_else(|| "credential writer was not invoked".into())
}
