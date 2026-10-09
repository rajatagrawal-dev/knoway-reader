import { useEffect, useRef, useState } from "react";

// A button's floating menu (the rail's, the page navigator's): closes on a
// click outside it or on Escape. Escape is caught in the capture phase and
// stopped there, so closing the menu doesn't also reach App's own Escape
// handling (which would drop the current tool back to Select).
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The zoom input handles its own Escape (cancel the edit, keep the menu).
      if (event.target instanceof HTMLInputElement && ref.current?.contains(event.target)) return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  return { open, setOpen, ref };
}
