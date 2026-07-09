import net from 'net';

export class ShardDbClient {
  private readonly host: string;
  private readonly port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  query(request: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        const text = data.replace(/\0/g, '').trim();
        if (!text) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      };

      socket.connect(this.port, this.host, () => {
        const payload = JSON.stringify(request) + '\n';
        socket.write(payload);
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\0\n')) {
          finish();
        }
      });

      socket.on('error', (err) => {
        if (!resolved) reject(new Error(`shard-db TCP error: ${err.message}`));
      });

      socket.setTimeout(10_000, () => {
        if (!resolved) {
          socket.destroy();
          reject(new Error('shard-db TCP timeout (10s)'));
        }
      });
    });
  }

  close(): void {
    // Nothing to clean up — each query creates its own socket
  }
}
