import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@fdw-engine/ui/components/ui/sidebar';
import { Collapsible } from '@fdw-engine/ui/components/ui/collapsible';
import { Label } from '@fdw-engine/ui/components/ui/label';

import { useSceneGraph } from '../hooks/useSceneGraph';
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from '@fdw-engine/ui/components/ui/collapsible';

import { Checkbox } from '@fdw-engine/ui/components/ui/checkbox';
import { Input } from '@fdw-engine/ui/components/ui/input';
import { ChevronDown } from 'lucide-react';
import { Group, Vector3 } from 'three';

function AppSidebarGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger>
            {label}
            <ChevronDown className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>{children}</SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function SidebarSceneItem({ label, scene }: { label: string; scene: Group }) {
  console.log(scene);

  const BoolValue = ({ label, value }: { label: string; value: boolean }) => {
    return (
      <div className="flex items-center justify-between w-full text-neutral-500">
        <div>{label}</div>
        <Checkbox checked={value} disabled className="read-only" />
      </div>
    );
  };

  const VecValue = ({ label, value }: { label: string; value: Vector3 }) => {
    return (
      <div className="flex items-end justify-between w-full text-neutral-500 ">
        <div className="pb-1 pr-1">{label}</div>
        <div className="flex items-center justify-between w-full text-neutral-500">
          <div className="grid w-full max-w-sm items-center">
            <Label htmlFor="x" className="pl-4">
              X
            </Label>
            <Input
              type="number"
              id="x"
              value={value.x}
              readOnly
              className="h-8"
            />
          </div>
          <div className="grid w-full max-w-sm items-center">
            <Label htmlFor="y" className="pl-4">
              Y
            </Label>
            <Input
              type="number"
              id="y"
              value={value.y}
              readOnly
              className="h-8"
            />
          </div>
          <div className="grid w-full max-w-sm items-center">
            <Label htmlFor="z" className="pl-4">
              Z
            </Label>
            <Input
              type="number"
              id="z"
              value={value.z}
              readOnly
              className="h-8"
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <AppSidebarGroup label={label}>
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-between w-full text-neutral-500">
            <Label>UUID</Label>
            <span
              className="font-mono text-xs text-ellipsis overflow-hidden text-neutral-400 w-32 whitespace-nowrap"
              title={scene.uuid}
            >
              {scene.uuid}
            </span>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu>
        <SidebarMenuItem>
          <BoolValue label="Cast Shadow" value={scene.castShadow} />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <BoolValue label="Receive Shadow" value={scene.receiveShadow} />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <BoolValue label="Frustum Culled" value={scene.frustumCulled} />
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu>
        <SidebarMenuItem>
          <VecValue label="Position" value={scene.position} />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <VecValue
            label="Rotation"
            value={new Vector3().applyEuler(scene.rotation)}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </AppSidebarGroup>
  );
}

function AppSidebar() {
  const sceneGraph = useSceneGraph();
  return (
    <Sidebar>
      <SidebarHeader>
        <h2>SceneGraph</h2>
      </SidebarHeader>
      <SidebarContent>
        <AppSidebarGroup label="Scenes">
          {sceneGraph.scenes.map((scene, index) => (
            <SidebarSceneItem
              key={index}
              label={`Scene ${index + 1}`}
              scene={scene}
            />
          ))}
        </AppSidebarGroup>
        <AppSidebarGroup label="Cameras">
          {sceneGraph.cameras.map((camera, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuButton asChild>
                <div>{camera.name || `Camera ${index + 1}`}</div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </AppSidebarGroup>
        <AppSidebarGroup label="Animations">
          {sceneGraph.animations.map((animation, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuButton asChild>
                <div>{animation.name || `Animation ${index + 1}`}</div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </AppSidebarGroup>
        <AppSidebarGroup label="Assets">
          {Object.entries(sceneGraph.asset).map(([asset, value], index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuButton asChild>
                <div>
                  {asset}: {value}
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </AppSidebarGroup>
        <AppSidebarGroup label="User Data">
          {Object.entries(sceneGraph.userData).map(([key, value], index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuButton asChild>
                <div>{key}</div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </AppSidebarGroup>
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}

export default AppSidebar;
