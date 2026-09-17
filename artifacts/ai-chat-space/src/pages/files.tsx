import { FileBrowser } from "@/components/files/file-browser";
import { ProjectPanel } from "@/components/projects/project-panel";
import { useState } from "react";

export function FilesPage() {
  const [path, setPath] = useState("");
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="mx-auto w-full max-w-5xl">
        <ProjectPanel compact onOpenFiles={(folder) => setPath(folder)} />
      </div>
      <div className="mx-auto min-h-0 w-full max-w-5xl flex-1">
        <FileBrowser initialPath={path} className="h-full" />
      </div>
    </div>
  );
}
