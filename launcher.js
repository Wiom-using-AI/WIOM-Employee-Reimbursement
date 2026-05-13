const { spawn } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const BACKEND = path.join(ROOT, "backend");
const FRONTEND = path.join(ROOT, "frontend");

function start(name, cmd, args, cwd) {
  function launch() {
    console.log(`[${name}] Starting...`);
    const proc = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: true,
      windowsHide: true,
    });
    proc.on("exit", (code) => {
      console.log(`[${name}] Exited (${code}), restarting in 3s...`);
      setTimeout(launch, 3000);
    });
    proc.on("error", (err) => {
      console.error(`[${name}] Error: ${err.message}, restarting in 3s...`);
      setTimeout(launch, 3000);
    });
  }
  launch();
}

start("backend",  "python", ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004"], BACKEND);
start("frontend", "npm",    ["run", "dev"],                                                         FRONTEND);

// Keep Node alive
setInterval(() => {}, 60000);
