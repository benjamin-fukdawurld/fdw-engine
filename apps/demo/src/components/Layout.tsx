import {
  SidebarProvider,
  SidebarTrigger,
} from '@fdw-engine/ui/components/ui/sidebar';
import React from 'react';
import AppSidebar from './AppSidebar';

type Props = {
  children: React.ReactNode;
};

function Layout({ children }: Props) {
  return (
    <div className="w-vw h-svh">
      <SidebarProvider>
        <AppSidebar />
        <main>
          <SidebarTrigger />
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}

export default Layout;
