/**
 * Optional cluster wrapper.
 *
 *   node src/cluster.js   -> one worker per CPU (VPS / future deployment)
 *   node src/index.js     -> single-process (HF Space, dev)
 *
 * The worker code is unchanged — the cluster wrapper simply forks
 * src/index.js into N children. All cross-worker coordination happens over
 * Redis pub/sub (see redis.js, ws_stream.js), so there is no worker-to-worker
 * state to synchronise here.
 */
const cluster = require('cluster');
const os = require('os');

if (cluster.isPrimary) {
  const n = Math.max(1, Math.min(Number(process.env.CLUSTER_WORKERS) || os.cpus().length, 16));
  console.log(`[cluster] forking ${n} workers`);
  for (let i = 0; i < n; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[cluster] worker ${worker.process.pid} died (code=${code} signal=${signal}) — respawning`);
    cluster.fork();
  });

  const shutdown = () => {
    console.log('[cluster] shutting down workers');
    for (const id in cluster.workers) cluster.workers[id].kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
} else {
  require('./index.js');
}
