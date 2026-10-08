import { createRootRoute, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

export const Route = createRootRoute({
  component: RouteComponent,
});

function RouteComponent() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <nav className="w-28 h-full px-4 pb-2 pt-16 flex flex-col items-center gap-4 bg-gray-800 text-gray-200 font-bold">
        <ul>
          <li className="w-28 ">
            <button
              className="flex items-center gap-2 w-full"
              onClick={() => setOpenIndex(openIndex === 0 ? null : 0)}
            >
              {openIndex === 0 ? <ChevronDown /> : <ChevronRight />}
              Basics
            </button>
            {openIndex === 0 && (
              <div className="h-full px-4 py-2 flex flex-col items-center gap-4 bg-gray-800 text-gray-200 font-bold overflow-y-auto">
                <a className="text-sm text-center" href="/">
                  Home
                </a>
                <a className="text-sm text-center" href="/triangle">
                  Triangle
                </a>
                <a className="text-sm text-center" href="/triangle-vertices">
                  Triangle Vertices
                </a>
                <a className="text-sm text-center" href="/triangle-hard-color">
                  Triangle Hard Coded Color
                </a>
                <a className="text-sm text-center" href="/colored-triangle">
                  Colored Triangle
                </a>
                <a
                  className="text-sm text-center"
                  href="/colored-triangle-interleaved"
                >
                  Colored Triangle Interleaved
                </a>
                <a className="text-sm text-center" href="/uniform">
                  Uniform
                </a>
                <a className="text-sm text-center" href="/textured-triangle">
                  Texture
                </a>
                <a className="text-sm text-center" href="/matrix">
                  Matrix
                </a>
                <a className="text-sm text-center" href="/camera">
                  Camera
                </a>
                <a className="text-sm text-center" href="/triangle-strip">
                  Triangle Strip
                </a>
                <a className="text-sm text-center" href="/face-culling">
                  Face Culling
                </a>
                <a className="text-sm text-center" href="/depth-testing">
                  Depth Testing
                </a>
                <a className="text-sm text-center" href="/index-buffer">
                  Index Buffer
                </a>
                <a className="text-sm text-center" href="/loading-model">
                  Loading Model
                </a>
                <a className="text-sm text-center" href="/material-graph">
                  Material Graph
                </a>
                <a className="text-sm text-center" href="/pbr">
                  PBR
                </a>
              </div>
            )}
          </li>
        </ul>
      </nav>
      <Outlet />
      <TanStackRouterDevtools />
    </div>
  );
}
