const path = require("path");

module.exports = {
  apps: [
    {
      name: "command-comms",
      script: "src/server.js",
      cwd: path.resolve(__dirname, ".."),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },
    },
  ],
};
