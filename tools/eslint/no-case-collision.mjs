// Forbids a file whose name differs from a sibling entry only in casing,
// such as Transform.ts next to a transform/ folder: './transform' then
// resolves to the file on Windows and macOS, to the folder on Linux.
// Names are compared as imports name them, without the extension, so
// Transform.spec.ts does not go with transform.ts.
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const stem = (name) => name.replace(/\.(d\.)?[cm]?[jt]sx?$/, '');

export default {
  rules: {
    'no-case-collision': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Forbid file names that differ from a sibling only in casing',
        },
        schema: [],
        messages: {
          collision:
            "'{{name}}' differs from '{{other}}' only in casing: imports resolve differently across platforms.",
        },
      },
      create(context) {
        const file = context.physicalFilename ?? context.filename;
        const name = stem(basename(file));
        return {
          Program(node) {
            let entries;
            try {
              entries = readdirSync(dirname(file));
            } catch {
              return;
            }
            const other = entries.find(
              (entry) =>
                stem(entry) !== name &&
                stem(entry).toLowerCase() === name.toLowerCase(),
            );
            if (other) {
              context.report({
                node,
                messageId: 'collision',
                data: { name: basename(file), other },
              });
            }
          },
        };
      },
    },
  },
};
