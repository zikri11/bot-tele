module.exports = {
  apps: [
    {
      name: 'bot-jaseb',
      script: 'dist/bot/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 3000,
      node_args: '--max-old-space-size=2048',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
