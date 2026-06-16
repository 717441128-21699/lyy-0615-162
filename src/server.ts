import { GameServer } from './core/GameServer';

const PORT = parseInt(process.env.PORT || '8080', 10);
const TICK_RATE = parseInt(process.env.TICK_RATE || '30', 10);
const HOT_RELOAD = process.env.HOT_RELOAD !== 'false';

async function main() {
  const server = new GameServer({
    port: PORT,
    config: {
      tickRate: TICK_RATE,
    },
    hotReload: HOT_RELOAD,
  });

  try {
    await server.start();
    console.log('\n=== Game Server Framework ===');
    console.log('Server is running and ready for connections.');
    console.log('');
    console.log('Key features:');
    console.log('  ✓ Room isolation via Worker Threads');
    console.log('  ✓ Fixed tick rate game loop');
    console.log('  ✓ Input buffering for deterministic gameplay');
    console.log('  ✓ State sync (delta + full snapshots)');
    console.log('  ✓ Reconnect with fast state recovery');
    console.log('  ✓ Hot reload support');
    console.log('');
    console.log('Endpoints:');
    console.log(`  Status:  http://localhost:${PORT}/status`);
    console.log(`  WebSocket: ws://localhost:${PORT}`);
    console.log('');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });
}

main();
