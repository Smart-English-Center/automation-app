const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

function clean_(value) {
  return String(value ?? "").trim();
}

function booleanEnv_(name, fallback = false) {
  const value = clean_(process.env[name]).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function driveFolderId_() {
  return clean_(
    process.env.GOOGLE_PDF_OUTPUT_FOLDER_ID ||
    process.env.GOOGLE_DRIVE_PDF_FOLDER_ID ||
    process.env.PDF_GOOGLE_DRIVE_FOLDER_ID ||
    ""
  );
}

function safeFilename_(value) {
  const clean = clean_(value) || `JEA Feedback - ${new Date().toISOString().slice(0, 10)}.pdf`;
  return clean
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function driveQueryLiteral_(value) {
  return clean_(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function cleanAppProperties_(value = {}) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [clean_(key), clean_(item)])
      .filter(([key, item]) => key && item)
  );
}

export function getGoogleDrivePdfConfigStatus() {
  return {
    client_id_configured: Boolean(clean_(process.env.GOOGLE_CLIENT_ID)),
    client_secret_configured: Boolean(clean_(process.env.GOOGLE_CLIENT_SECRET)),
    refresh_token_configured: Boolean(clean_(process.env.GOOGLE_REFRESH_TOKEN)),
    folder_id_configured: Boolean(driveFolderId_()),
    folder_id: driveFolderId_() ? "configured" : "",
    share_anyone: booleanEnv_("GOOGLE_DRIVE_PDF_SHARE_ANYONE", false)
  };
}

export async function getGoogleDriveAccessToken() {
  const clientId = clean_(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = clean_(process.env.GOOGLE_CLIENT_SECRET);
  const refreshToken = clean_(process.env.GOOGLE_REFRESH_TOKEN);

  if (!clientId) throw new Error("Missing GOOGLE_CLIENT_ID for Google Drive PDF upload.");
  if (!clientSecret) throw new Error("Missing GOOGLE_CLIENT_SECRET for Google Drive PDF upload.");
  if (!refreshToken) throw new Error("Missing GOOGLE_REFRESH_TOKEN for Google Drive PDF upload.");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Google token endpoint returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (!response.ok || !json.access_token) {
    throw new Error(`Google token refresh failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  return json.access_token;
}

async function downloadPdf_(downloadUrl) {
  const url = clean_(downloadUrl);
  if (!url) throw new Error("Missing PDF download URL for Google Drive upload.");

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Could not download PDF before Drive upload. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export function assertContentfulPdfBuffer(pdfBuffer,{minBytes=2048}={}){
  if(!Buffer.isBuffer(pdfBuffer))throw new Error("Downloaded PDF is not a Node.js Buffer.");
  const minimum=Number.isFinite(Number(minBytes))&&Number(minBytes)>0?Math.floor(Number(minBytes)):2048;
  if(pdfBuffer.length<minimum){
    throw new Error(`Downloaded PDF appears blank or incomplete: ${pdfBuffer.length} bytes; minimum accepted size is ${minimum} bytes.`);
  }
  if(pdfBuffer.subarray(0,5).toString("ascii")!=="%PDF-"){
    throw new Error("Downloaded file does not have a valid PDF header.");
  }
  const source=pdfBuffer.toString("latin1");
  const contentReferences=[...source.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)].map((match)=>match[1]);
  if(contentReferences.length&&contentReferences.every((objectId)=>{
    const escaped=objectId.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    return new RegExp(`${escaped}\\s+0\\s+obj[\\s\\S]{0,160}?\/Length\\s+0(?:\\s|>>)`).test(source);
  })){
    throw new Error("Downloaded PDF contains only zero-length page content streams.");
  }
  return{sizeBytes:pdfBuffer.length};
}

async function makeAnyoneReader_(accessToken, fileId) {
  const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      role: "reader",
      type: "anyone"
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Google Drive permission update failed. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
}

export async function uploadPdfUrlToGoogleDrive(downloadUrl, options = {}) {
  const accessToken = await getGoogleDriveAccessToken();
  const folderId = clean_(options.folderId) || driveFolderId_();
  const filename = safeFilename_(options.filename);
  const pdfBuffer = await downloadPdf_(downloadUrl);

  if(options.requireContentfulPdf){
    assertContentfulPdfBuffer(pdfBuffer,{minBytes:options.minPdfBytes});
  }

  const metadata = {
    name: filename,
    mimeType: "application/pdf"
  };

  if (folderId) {
    metadata.parents = [folderId];
  }

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "file",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    filename
  );

  const uploadResponse = await fetch(
    `${GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink,webContentLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: form
    }
  );

  const text = await uploadResponse.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Google Drive upload returned non-JSON response. HTTP ${uploadResponse.status}: ${text.slice(0, 1000)}`);
  }

  if (!uploadResponse.ok || !json.id) {
    throw new Error(`Google Drive PDF upload failed. HTTP ${uploadResponse.status}: ${JSON.stringify(json)}`);
  }

  if (booleanEnv_("GOOGLE_DRIVE_PDF_SHARE_ANYONE", false)) {
    await makeAnyoneReader_(accessToken, json.id);
  }

  const driveUrl = clean_(json.webViewLink) || `https://drive.google.com/file/d/${encodeURIComponent(json.id)}/view`;

  return {
    ok: true,
    drive_file_id: json.id,
    drive_url: driveUrl,
    web_view_link: driveUrl,
    web_content_link: clean_(json.webContentLink),
    filename: clean_(json.name) || filename,
    folder_id: folderId,
    shared_anyone: booleanEnv_("GOOGLE_DRIVE_PDF_SHARE_ANYONE", false)
  };
}


export async function uploadBufferToGoogleDrive(buffer, options = {}) {
  const accessToken = await getGoogleDriveAccessToken();
  const folderId = clean_(options.folderId || options.folder_id || process.env.GOOGLE_AUDIO_STORAGE_FOLDER_ID || process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID || "");
  const filename = safeFilename_(options.filename || `JEA Audio - ${new Date().toISOString().slice(0, 10)}`);
  const mimeType = clean_(options.mimeType || options.mime_type || "application/octet-stream");
  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");

  if (!fileBuffer.length) {
    throw new Error("Cannot upload an empty buffer to Google Drive.");
  }

  const metadata = {
    name: filename,
    mimeType
  };

  const appProperties = cleanAppProperties_(options.appProperties || options.app_properties);
  if (Object.keys(appProperties).length) metadata.appProperties = appProperties;

  if (folderId) {
    metadata.parents = [folderId];
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const uploadResponse = await fetch(
    `${GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,webContentLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: form
    }
  );

  const text = await uploadResponse.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Google Drive upload returned non-JSON response. HTTP ${uploadResponse.status}: ${text.slice(0, 1000)}`);
  }

  if (!uploadResponse.ok || !json.id) {
    throw new Error(`Google Drive upload failed. HTTP ${uploadResponse.status}: ${JSON.stringify(json)}`);
  }

  const driveUrl = clean_(json.webViewLink) || `https://drive.google.com/file/d/${encodeURIComponent(json.id)}/view`;

  return {
    ok: true,
    drive_file_id: json.id,
    drive_url: driveUrl,
    web_view_link: driveUrl,
    web_content_link: clean_(json.webContentLink),
    filename: clean_(json.name) || filename,
    mime_type: clean_(json.mimeType) || mimeType,
    size_bytes: Number(json.size || fileBuffer.length || 0),
    folder_id: folderId
  };
}

export async function findGoogleDriveFileByAppProperty(key, value, options = {}) {
  const propertyKey = clean_(key);
  const propertyValue = clean_(value);
  if (!propertyKey || !propertyValue) throw new Error("A Google Drive app-property key and value are required.");

  const accessToken = clean_(options.accessToken) || await getGoogleDriveAccessToken();
  const folderId = clean_(options.folderId || options.folder_id);
  const query = [
    "trashed = false",
    `appProperties has { key='${driveQueryLiteral_(propertyKey)}' and value='${driveQueryLiteral_(propertyValue)}' }`
  ];
  if (folderId) query.push(`'${driveQueryLiteral_(folderId)}' in parents`);

  const search = new URLSearchParams({
    q: query.join(" and "),
    spaces: "drive",
    pageSize: "10",
    orderBy: "createdTime",
    fields: "files(id,name,mimeType,size,webViewLink,webContentLink,appProperties,createdTime)"
  });
  search.set("supportsAllDrives", "true");
  search.set("includeItemsFromAllDrives", "true");

  const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}?${search.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`Google Drive source-marker lookup returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  if (!response.ok) {
    throw new Error(`Google Drive source-marker lookup failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  const file = Array.isArray(json.files) ? json.files[0] : null;
  if (!file?.id) return null;
  const driveUrl = clean_(file.webViewLink) || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
  return {
    drive_file_id: clean_(file.id),
    drive_url: driveUrl,
    web_view_link: driveUrl,
    web_content_link: clean_(file.webContentLink),
    filename: clean_(file.name),
    mime_type: clean_(file.mimeType),
    size_bytes: Number(file.size || 0),
    app_properties: file.appProperties || {},
    created_time: clean_(file.createdTime)
  };
}

export async function updateGoogleDriveFileAppProperties(fileId, properties = {}, options = {}) {
  const cleanFileId = clean_(fileId);
  const appProperties = cleanAppProperties_(properties);
  if (!cleanFileId) throw new Error("A Google Drive file ID is required to update app properties.");
  if (!Object.keys(appProperties).length) return null;
  const accessToken = clean_(options.accessToken) || await getGoogleDriveAccessToken();
  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(cleanFileId)}?supportsAllDrives=true&fields=id,appProperties`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties })
    }
  );
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`Google Drive source-marker update returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  if (!response.ok || !json.id) {
    throw new Error(`Google Drive source-marker update failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

export async function getGoogleDriveFileMetadata(fileId) {
  const cleanFileId = clean_(fileId);
  if (!cleanFileId) throw new Error("Missing Google Drive file ID.");

  const accessToken = await getGoogleDriveAccessToken();
  const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(cleanFileId)}?fields=id,name,mimeType,size,webViewLink,webContentLink`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Google Drive metadata returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (!response.ok || !json.id) {
    throw new Error(`Google Drive metadata lookup failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  return {
    id: clean_(json.id),
    name: clean_(json.name),
    mime_type: clean_(json.mimeType),
    size_bytes: Number(json.size || 0),
    web_view_link: clean_(json.webViewLink),
    web_content_link: clean_(json.webContentLink)
  };
}

export async function downloadGoogleDriveFileBuffer(fileId) {
  const cleanFileId = clean_(fileId);
  if (!cleanFileId) throw new Error("Missing Google Drive file ID for download.");

  const accessToken = await getGoogleDriveAccessToken();
  const metadata = await getGoogleDriveFileMetadata(cleanFileId);

  const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(cleanFileId)}?alt=media`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const contentType = clean_(response.headers.get("content-type"));
  const contentLength = Number(response.headers.get("content-length") || metadata.size_bytes || 0);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google Drive audio download failed. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Google Drive audio download returned an empty file.");

  return {
    ok: true,
    drive_file_id: cleanFileId,
    filename: metadata.name || `${cleanFileId}.audio`,
    mime_type: contentType || metadata.mime_type || "application/octet-stream",
    size_bytes: buffer.length || contentLength || metadata.size_bytes || 0,
    buffer,
    metadata
  };
}
