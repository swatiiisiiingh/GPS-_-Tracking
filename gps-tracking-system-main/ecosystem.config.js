// PM2 Ecosystem Config — NTPC-MUNPL GPS Tracking System
// Usage:
//   Start:   pm2 start ecosystem.config.js
//   Reload:  pm2 reload ntpc-gps
//   Stop:    pm2 stop ntpc-gps
//   Logs:    pm2 logs ntpc-gps
//   Status:  pm2 status

module.exports = {
  apps: [
    {
      name: 'ntpc-gps',            // App name shown in PM2 dashboard
      script: 'backend/server.js', // Run the backend server
      cwd: 'backend',              // Run in backend context (resolves local .env and database)
      instances: 1,                // Single instance (Socket.IO requires sticky sessions for multi-instance)
      exec_mode: 'fork',

      // Environment
      env_production: {
        NODE_ENV: 'production',
      },

      // Logging
      out_file:   './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Auto-restart policy
      watch: false,                // Do NOT watch files in production
      max_memory_restart: '300M',  // Restart if memory exceeds 300 MB
      restart_delay: 3000,         // Wait 3 s before restarting after crash
      max_restarts: 10,            // After 10 crashes, stop trying
      min_uptime: '10s',           // Must run for 10 s to count as "started"

      // Graceful shutdown
      kill_timeout: 5000,          // Give 5 s for graceful shutdown (SIGTERM)
      listen_timeout: 10000,       // Wait 10 s for server to be ready
    }
  ]
};
