import { fetchApiResponse } from "./sync";

export async function requestExportAfterSync(
  sync: () => Promise<void>,
  fetcher: typeof fetch,
): Promise<Response> {
  await sync();
  const response = await fetchApiResponse(fetcher, "/api/export", { method: "GET" });
  if (!response.ok) throw new Error("export_failed");
  return response;
}

export async function downloadExport(response: Response): Promise<void> {
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download =
      response.headers
        .get("Content-Disposition")
        ?.match(/filename="(task-export-\d{4}-\d{2}-\d{2}\.json)"/i)?.[1] ?? "task-export.json";
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
