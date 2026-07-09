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

      socket.connect(this.port, this.host, () => {
        socket.write(JSON.stringify(request) + '\n');
        socket.end();
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
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
      });

      socket.on('error', (err) => {
        reject(new Error(`shard-db TCP error: ${err.message}`));
      });

      socket.setTimeout(10_000, () => {
        socket.destroy();
        reject(new Error('shard-db TCP timeout (10s)'));
      });
    });
  }

  close(): void {
    // Nothing to clean up — each query creates its own socket
  }
}
