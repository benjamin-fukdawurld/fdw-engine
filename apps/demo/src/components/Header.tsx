import { memo } from 'react';
import {
  backendLabels,
  BackendName,
  getBackendName,
  switchBackend,
} from '../globals/backend';

const Header = memo(() => {
  const current = getBackendName();
  return (
    <header className="w-full h-16 bg-gray-800 text-white flex items-center justify-center text-xl font-bold">
      Header
      <span className="ml-8 flex gap-2 text-sm font-normal">
        {(Object.keys(backendLabels) as BackendName[]).map((name) => (
          <button
            key={name}
            className={`px-2 py-1 rounded ${
              name === current
                ? 'bg-gray-200 text-gray-800'
                : 'text-gray-400 hover:text-white'
            }`}
            disabled={name === current}
            onClick={() => switchBackend(name)}
          >
            {backendLabels[name]}
          </button>
        ))}
      </span>
    </header>
  );
});

export default Header;
