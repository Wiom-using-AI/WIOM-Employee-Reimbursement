module.exports = {
  apps: [
    {
      name: "wiom-app",
      script: "launcher.js",
      cwd: "C:\\Users\\Tushar Gupta\\Desktop\\Claude Working Agent 1\\expense-validator",
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      error_file: "logs\\app-err.log",
      out_file: "logs\\app-out.log",
      time: true,
    },
  ],
};
