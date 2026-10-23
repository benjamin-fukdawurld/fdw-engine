import type { FileFilter, HostFile, HostFiles } from '@fdw/editor-ui';

// The File System Access API, in Chromium only: not in the DOM library.
interface PickerType {
  readonly description: string;
  readonly accept: Record<string, string[]>;
}
interface FilePickers {
  showOpenFilePicker?(options: {
    types?: PickerType[];
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options: {
    suggestedName?: string;
    types?: PickerType[];
  }): Promise<FileSystemFileHandle>;
}

const pickers = window as Window & FilePickers;

const pickerTypes = (filters: readonly FileFilter[] = []): PickerType[] =>
  filters.map(({ name, extensions }) => ({
    description: name,
    accept: {
      'application/octet-stream': extensions.map(
        (extension) => `.${extension}`,
      ),
    },
  }));

// A dialog closed without a choice.
const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

async function read(file: File): Promise<HostFile> {
  return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

// Without the API: an input of type file.
function pickFile(filters: readonly FileFilter[] = []) {
  return new Promise<File | undefined>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters
      .flatMap(({ extensions }) => extensions.map((e) => `.${e}`))
      .join(',');
    input.addEventListener('change', () => resolve(input.files?.[0]));
    input.addEventListener('cancel', () => resolve(undefined));
    input.click();
  });
}

// Without the API: a download, which the browser may name otherwise.
function download(name: string, data: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([data]));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

/**
 * The files of the user on the web: the File System Access API where the
 * browser has it (Chromium), else an import and a download.
 */
export const webFiles: HostFiles = {
  async open(filters) {
    if (!pickers.showOpenFilePicker) {
      const file = await pickFile(filters);
      return file && read(file);
    }
    try {
      const [handle] = await pickers.showOpenFilePicker({
        types: pickerTypes(filters),
      });
      return handle && read(await handle.getFile());
    } catch (error) {
      if (isAbort(error)) return undefined;
      throw error;
    }
  },
  async save(name, data, filters) {
    if (!pickers.showSaveFilePicker) {
      download(name, data);
      return true;
    }
    try {
      const handle = await pickers.showSaveFilePicker({
        suggestedName: name,
        types: pickerTypes(filters),
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return true;
    } catch (error) {
      if (isAbort(error)) return false;
      throw error;
    }
  },
};
