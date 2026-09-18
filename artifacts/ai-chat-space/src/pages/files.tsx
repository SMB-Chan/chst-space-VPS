import { FileBrowser } from "@/components/files/file-browser";
import { ProjectPanel } from "@/components/projects/project-panel";
import { useEffect, useState } from "react";

export function FilesPage() {
  const [path, setPath] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("path");
    if (q) setPath(q);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="mx-auto w-full max-w-5xl">
        <ProjectPanel
          onOpenFiles={(folder) => setPath(folder)}
        />
      </div>
      <div className="mx-auto min-h-0 w-full max-w-5xl flex-1">
        <FileBrowser initialPath={path} className="h-full" />
      </div>
    </div>
  );
}
