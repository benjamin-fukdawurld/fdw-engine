import { memo } from 'react';
import { useEngine } from '../hooks/useEngine';

const Header = memo(() => {
  const { engine } = useEngine();
  return (
    <header className="w-full h-16 bg-gray-800 text-white flex items-center justify-center text-xl font-bold">
      Header
      <span className="ml-4 text-sm font-normal text-gray-400"></span>
    </header>
  );
});

export default Header;
