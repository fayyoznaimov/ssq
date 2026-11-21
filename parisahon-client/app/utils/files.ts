const supportedExtensions: Record<string, number> = {
    js: 1,
    pdf: 1,
    jpg: 1,
    png: 1,
    html: 1,
    doc: 1,
    css: 1,
    xls: 1,
    zip: 1,
    ppt: 1,
};

export const getFileIcon = (fileName?: string) => {
    if (!fileName) {
        return "ph:file";
    }

    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext && supportedExtensions[ext]) return `ph:file-${ext}`;
    return "ph:file";
};

/** Per file, the same as FileService.MAX_FILE_SIZE in the API (nginx takes 10 MB per request) */
export const MAX_UPLOAD_MB = 10;

/** Address of an uploaded file (the `path` of a file row): <apiUrl>/uploads/<path> */
export const uploadUrl = (path: string) => (path ? `${useApiUrl()}/uploads/${path}` : "");

/**
 * Saves an uploaded file under its own name: the name on disk is random, and
 * <a download> ignores the name for another origin. Throws when it is gone.
 */
export const downloadFile = async (fileUrl: string, fileName?: string) => {
    const response = await fetch(fileUrl, { method: "GET" });
    if (!response.ok) {
        throw new Error(response.status === 404 ? "Файл не найден" : "Не удалось скачать файл");
    }

    const url = window.URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || fileUrl.split("/").pop() || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
};
