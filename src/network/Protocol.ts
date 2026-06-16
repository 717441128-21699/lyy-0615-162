import { NetworkMessage } from '../types';

export class Protocol {
  static encode(message: NetworkMessage): string {
    return JSON.stringify(message);
  }

  static decode(data: string): NetworkMessage {
    return JSON.parse(data);
  }

  static create(type: NetworkMessage['type'], payload: any): NetworkMessage {
    return { type, payload };
  }
}

export function serializeMessage(message: NetworkMessage): Buffer {
  return Buffer.from(Protocol.encode(message), 'utf-8');
}

export function deserializeMessage(data: Buffer): NetworkMessage {
  return Protocol.decode(data.toString('utf-8'));
}
