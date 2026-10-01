// SPDX-License-Identifier: AGPL-3.0-only
import {
  ChevronRightIcon,
  FolderIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { probeWasmUrl, probeWoff2Url } from "../assets/assetUrls.js";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.js";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert.js";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../components/ui/autocomplete.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../components/ui/collapsible.js";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/ui/command.js";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { DraftInput } from "../components/ui/draft-input.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "../components/ui/input-group.js";
import { Input } from "../components/ui/input.js";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { Label } from "../components/ui/label.js";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu.js";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
  NumberFieldScrubArea,
} from "../components/ui/number-field.js";
import { PanelTabCloseButton } from "../components/ui/panel-tab-close-button.js";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { QRCodeSvg } from "../components/ui/qr-code.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Separator } from "../components/ui/separator.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "../components/ui/sidebar.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Spinner } from "../components/ui/spinner.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { Toggle } from "../components/ui/toggle.js";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "../components/ui/tooltip.js";

const harnesses = ["claude", "codex", "opencode"].map((value) => ({
  label: value,
  value,
}));
const commands = [
  {
    value: "Actions",
    items: ["New task", "New terminal", "Toggle sidebar", "Open browser"],
  },
];
const models = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];
const noop = () => {};

function DraftInputSample() {
  const [name, setName] = useState("api");
  return (
    <div className="flex flex-col gap-2">
      <DraftInput aria-label="Task name" value={name} onCommit={setName} />
      <span className="text-muted-foreground text-xs">committed: {name}</span>
    </div>
  );
}

export const GALLERY_SECTIONS: ReadonlyArray<{
  readonly id: string;
  readonly render: () => ReactNode;
}> = [
  {
    id: "button",
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Button>Create</Button>
        <Button variant="secondary">Copy</Button>
        <Button variant="outline">Pause</Button>
        <Button variant="ghost">Wake</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="destructive-outline">Discard</Button>
        <Button variant="link">Versions</Button>
        <Button variant="glass">Glass</Button>
        <Button size="xs">xs</Button>
        <Button>default</Button>
        <Button size="icon" aria-label="Terminal">
          <TerminalIcon />
        </Button>
        <Button size="icon" variant="ghost" aria-label="More">
          <MoreHorizontalIcon />
        </Button>
        <Button disabled>Disabled</Button>
      </div>
    ),
  },
  {
    id: "alert",
    render: () => (
      <div className="flex flex-col">
        <Alert>
          <TerminalIcon />
          <AlertTitle>wsp is not running, reconnecting.</AlertTitle>
          <AlertDescription>Start wsp in a terminal and this page picks it up.</AlertDescription>
        </Alert>
        <Alert>
          <GlobeIcon />
          <AlertTitle>A sign-in page is ready on api</AlertTitle>
          <AlertAction>
            <Button size="xs" variant="outline">
              Open
            </Button>
          </AlertAction>
        </Alert>
      </div>
    ),
  },
  {
    id: "input",
    render: () => (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-name">Task name</Label>
          <Input id="g-name" placeholder="api" />
        </div>
        <Textarea placeholder="What should we build in api?" rows={3} />
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>https://</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput placeholder="m1-3000.preview.example" />
          <InputGroupAddon align="inline-end">
            <Kbd>Enter</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <InputGroup>
          <InputGroupTextarea placeholder="Notes" rows={2} />
          <InputGroupAddon align="block-end">
            <InputGroupText>0 / 280</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <DraftInputSample />
      </div>
    ),
  },
  {
    id: "number-field",
    render: () => (
      <NumberField defaultValue={4} min={1} max={32}>
        <NumberFieldScrubArea label="vCPUs" />
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
    ),
  },
  {
    id: "selection",
    render: () => (
      <div className="flex flex-col gap-3">
        <Label className="flex items-center gap-2">
          <Checkbox defaultChecked /> Keep RAM on pause
        </Label>
        <Label className="flex items-center gap-2">
          <Switch defaultChecked /> Preview URLs
        </Label>
        <RadioGroup defaultValue="fork" className="flex gap-4">
          <Label className="flex items-center gap-2">
            <Radio value="fork" /> Copy
          </Label>
          <Label className="flex items-center gap-2">
            <Radio value="fresh" /> Fresh
          </Label>
        </RadioGroup>
        <div className="flex items-center gap-2">
          <Toggle aria-label="Pin" size="sm" variant="outline">
            <PinIcon />
          </Toggle>
          <ToggleGroup
            defaultValue={["chat"]}
            variant="segmented"
            size="segmented"
          >
            <ToggleGroupItem value="chat">Chat</ToggleGroupItem>
            <ToggleGroupItem value="terminal">Terminal</ToggleGroupItem>
            <ToggleGroupItem value="browser">Browser</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    ),
  },
  {
    id: "select",
    render: () => (
      <div className="flex flex-col gap-3">
        <Select items={harnesses} defaultValue="claude">
          <SelectTrigger size="sm" aria-label="Harness">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {harnesses.map((h) => (
              <SelectItem key={h.value} value={h.value}>
                {h.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Autocomplete items={models}>
          <AutocompleteInput placeholder="Search models" aria-label="Model" />
          <AutocompletePopup>
            <AutocompleteEmpty>No model</AutocompleteEmpty>
            <AutocompleteList>
              {(item: string) => (
                <AutocompleteItem key={item} value={item}>
                  {item}
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
      </div>
    ),
  },
  {
    id: "command",
    render: () => (
      <div className="flex flex-col overflow-hidden rounded-xl border">
        <Command items={commands}>
          <CommandInput
            placeholder="Search commands"
            aria-label="Search commands"
          />
          <CommandEmpty>No command</CommandEmpty>
          <CommandList>
            {(group: (typeof commands)[number]) => (
              <CommandGroup key={group.value} items={group.items}>
                <CommandGroupLabel>{group.value}</CommandGroupLabel>
                <CommandCollection>
                  {(item: string) => (
                    <CommandItem key={item} value={item}>
                      {item}
                      <CommandShortcut>⌘N</CommandShortcut>
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
          <CommandFooter>
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            <span className="text-muted-foreground text-xs">to navigate</span>
          </CommandFooter>
        </Command>
      </div>
    ),
  },
  {
    id: "overlays",
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>
            Dialog
          </DialogTrigger>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>New task</DialogTitle>
              <DialogDescription>
                A copy of your image where you pick.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input placeholder="name" aria-label="Name" />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button>Create</Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="outline" />}>
            Alert dialog
          </AlertDialogTrigger>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete task?</AlertDialogTitle>
              <AlertDialogDescription>
                The computer and the images on it are removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                Keep
              </AlertDialogClose>
              <AlertDialogClose render={<Button variant="destructive" />}>
                Delete
              </AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>
            Popover
          </PopoverTrigger>
          <PopoverPopup>
            <p className="text-sm">2h 14m awake, $0.91 accrued.</p>
          </PopoverPopup>
        </Popover>
        <Menu>
          <MenuTrigger render={<Button variant="outline" />}>
            Menu
          </MenuTrigger>
          <MenuPopup>
            <MenuGroup>
              <MenuGroupLabel>Task</MenuGroupLabel>
              <MenuItem>
                Fork <MenuShortcut>⌘F</MenuShortcut>
              </MenuItem>
              <MenuItem>Pause</MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem defaultChecked>Show ports</MenuCheckboxItem>
            <MenuRadioGroup defaultValue="dense">
              <MenuRadioItem value="dense">Dense</MenuRadioItem>
              <MenuRadioItem value="comfy">Comfortable</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSub>
              <MenuSubTrigger>Move to</MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem>Frankfurt</MenuItem>
                <MenuItem>Tokyo</MenuItem>
              </MenuSubPopup>
            </MenuSub>
          </MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" />}>
            Tooltip
          </TooltipTrigger>
          <TooltipPopup>Opens the task panel</TooltipPopup>
        </Tooltip>
      </div>
    ),
  },
  {
    id: "disclosure",
    render: () => (
      <div className="flex flex-col gap-3">
        <Collapsible defaultOpen>
          <CollapsibleTrigger render={<Button variant="ghost" />}>
            <ChevronRightIcon /> versions
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <p className="text-muted-foreground px-2 py-1 text-sm">
              v4 → api → api-2
            </p>
          </CollapsiblePanel>
        </Collapsible>
        <div className="group/tab flex w-40 items-center gap-2 rounded-md border px-2 py-1 text-sm">
          <PanelTabCloseButton
            label="Close terminal 1"
            onClick={noop}
            tooltip="Close"
          >
            <TerminalIcon className="size-3" />
          </PanelTabCloseButton>
          terminal 1
        </div>
      </div>
    ),
  },
  {
    id: "scroll-area",
    render: () => (
      <ScrollArea className="h-32 rounded-md border" scrollFade>
        <ul className="p-2 text-sm">
          {Array.from({ length: 24 }, (_, i) => (
            <li key={i} className="py-1">
              event {i + 1}
            </li>
          ))}
        </ul>
      </ScrollArea>
    ),
  },
  {
    id: "empty",
    render: () => (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No threads yet.</EmptyTitle>
          <EmptyDescription>Start one from the composer.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ),
  },
  {
    id: "status",
    render: () => (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Spinner />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="size-8 rounded-full" />
        </div>
        <Separator />
        <div className="flex items-center gap-3 text-sm">
          <span>left</span>
          <Separator orientation="vertical" className="h-4" />
          <span>right</span>
        </div>
        <div className="flex items-center gap-2">
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          <Kbd>Esc</Kbd>
        </div>
      </div>
    ),
  },
  {
    id: "qr-code",
    render: () => (
      <QRCodeSvg
        value="wsp://pair/m1?ticket=demo"
        size={96}
        title="Pairing code"
      />
    ),
  },
  {
    id: "sidebar",
    render: () => (
      <SidebarProvider className="min-h-0 h-80 overflow-hidden rounded-md border">
        <Sidebar collapsible="none" className="h-full w-60">
          <SidebarHeader>
            <SidebarInput placeholder="Search" aria-label="Search" />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Tasks</SidebarGroupLabel>
              <SidebarGroupAction aria-label="New task">
                <PlusIcon />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive tooltip="api">
                      <FolderIcon /> api
                    </SidebarMenuButton>
                    <SidebarMenuAction showOnHover aria-label="More">
                      <MoreHorizontalIcon />
                    </SidebarMenuAction>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton isActive href="#gallery">
                          fix the port list
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton size="sm" href="#gallery">
                          move to node 22
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <FolderIcon /> web
                    </SidebarMenuButton>
                    <SidebarMenuBadge>2</SidebarMenuBadge>
                  </SidebarMenuItem>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
          </SidebarContent>
          <SidebarFooter>
            <SidebarTrigger />
          </SidebarFooter>
        </Sidebar>
      </SidebarProvider>
    ),
  },
  {
    id: "assets",
    render: () => (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
        <dt className="text-muted-foreground">wasm</dt>
        <dd className="truncate">{probeWasmUrl}</dd>
        <dt className="text-muted-foreground">woff2</dt>
        <dd className="truncate">{probeWoff2Url}</dd>
      </dl>
    ),
  },
];

/** Every copied primitive with sample props, so the kit is proven in this build. */
export function Gallery() {
  return (
    <main className="bg-background text-foreground min-h-svh p-6">
      <header className="mb-6 flex items-baseline gap-3">
        <h1 className="text-base font-medium">ui kit gallery</h1>
        <span className="text-muted-foreground font-mono text-xs">
          {GALLERY_SECTIONS.length} sections
        </span>
      </header>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {GALLERY_SECTIONS.map(({ id, render }) => (
          <section
            key={id}
            aria-labelledby={`gallery-${id}`}
            className="bg-card min-w-0 rounded-lg border p-4"
          >
            <h2
              id={`gallery-${id}`}
              className="text-muted-foreground mb-3 font-mono text-xs"
            >
              {id}
            </h2>
            {render()}
          </section>
        ))}
      </div>
    </main>
  );
}
