use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

// Holds the child process for the bundled Deep Dive API server (see
// scripts/build-server.mjs) so it can be killed when the app exits.
struct ServerProcess(Mutex<Option<Child>>);

// GUI apps on macOS/Linux launch with a minimal PATH (e.g. /usr/bin:/bin)
// that usually doesn't include a user-managed Node install (nvm, volta,
// Homebrew, ...). Route through an interactive login shell so `node`
// resolves the same way it would from a terminal. Windows doesn't have
// this problem — PATH there is a global environment variable, not
// assembled by shell rc files — so spawn `node` directly.
fn spawn_server(resource_path: &std::path::Path) -> std::io::Result<Child> {
  let mut cmd = if cfg!(target_os = "windows") {
    let mut cmd = Command::new("node");
    cmd.arg(resource_path);
    cmd
  } else {
    let shell = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
    let quoted = format!("'{}'", resource_path.to_string_lossy().replace('\'', "'\\''"));
    let mut cmd = Command::new(shell);
    // `exec` replaces the shell with node in-place (same pid), so killing
    // the Child returned by spawn() below actually kills the server
    // instead of just the shell wrapper.
    cmd.arg("-ilc").arg(format!("exec node {quoted}"));
    cmd
  };

  cmd
    .env("NODE_ENV", "production")
    .env("PORT", "4300")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ServerProcess(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
        // In dev, `beforeDevCommand` (`npm run dev`) already runs the
        // Deep Dive API server alongside Vite, so there's nothing to spawn.
      } else {
        // A packaged build has no `npm run dev` process running the
        // Express server, so start the bundled copy ourselves using the
        // system Node.js install. It still shells out to the local
        // `claude` CLI for Deep Dive, same as in dev.
        let resource_path = app
          .path()
          .resolve("resources/server.mjs", tauri::path::BaseDirectory::Resource)
          .expect("failed to resolve bundled server.mjs resource path");

        match spawn_server(&resource_path) {
          Ok(child) => {
            app.state::<ServerProcess>().0.lock().unwrap().replace(child);
          }
          Err(err) => {
            eprintln!(
              "MuseReader: failed to start the Deep Dive server (is Node.js installed and on PATH?): {err}"
            );
          }
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let RunEvent::Exit = event {
        if let Some(mut child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
          let _ = child.kill();
        }
      }
    });
}
