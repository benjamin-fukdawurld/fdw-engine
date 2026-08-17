export type BinaryData = ArrayBuffer | Uint8Array | Blob;

export interface ConversionOptions {
  encoding?: string;
  format?: 'text' | 'base64' | 'hex';
}

export async function binaryToString(
  data: BinaryData,
  options: ConversionOptions = {}
): Promise<string> {
  const { encoding = 'utf-8', format = 'text' } = options;

  // Normaliser en Uint8Array
  let bytes: Uint8Array;
  if (data instanceof Blob) {
    const arrayBuffer = await data.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }

  // Convertir selon le format demandé
  switch (format) {
    case 'base64': {
      const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
      return btoa(binary);
    }
    case 'hex':
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    case 'text':
    default: {
      const decoder = new TextDecoder(encoding);
      return decoder.decode(bytes);
    }
  }
}

export async function* readLines(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error('Response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        yield line;
      }

      if (buffer.length > 0) {
        yield buffer;
        buffer = '';
      }
    }
  } finally {
    reader.releaseLock();
  }
}
