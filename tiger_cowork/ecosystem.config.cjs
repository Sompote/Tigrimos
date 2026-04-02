module.exports = {
  apps: [{
    name: "cowork",
    script: "./node_modules/.bin/tsx",
    args: "server/index.ts",
    cwd: "/root/cowork",
    env: {
      NODE_ENV: "production",
    },
    // Restart policy
    max_restarts: 50,
    min_uptime: "10s",
    restart_delay: 3000,
    // Auto-restart on file changes (server only)
    watch: false,
    // Logging
    error_file: "/root/.pm2/logs/cowork-error.log",
    out_file: "/root/.pm2/logs/cowork-out.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    // Memory limit — restart if exceeds 512MB
    max_memory_restart: "512M",
    // Graceful shutdown
    kill_timeout: 5000,
  }],
};
