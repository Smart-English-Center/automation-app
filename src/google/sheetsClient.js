import { getGoogleDriveAccessToken } from "./driveClient.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function clean_(value) {
  return String(value ?? "").trim();
}

function encodeRange_(sheetName, range = "A:ZZ") {
  const safeSheetName = clean_(sheetName).replace(/'/g, "''");
  return `'${safeSheetName}'!${range}`;
}

export async function getSpreadsheetValues({ spreadsheetId, sheetName, range = "A:ZZ" } = {}) {
  const id = clean_(spreadsheetId);
  const tab = clean_(sheetName);

  if (!id) throw new Error("spreadsheetId is required.");
  if (!tab) throw new Error("sheetName is required.");

  const token = await getGoogleDriveAccessToken();
  const encodedRange = encodeURIComponent(encodeRange_(tab, range));
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(id)}/values/${encodedRange}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Google Sheets returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (!response.ok) {
    throw new Error(`Google Sheets read failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  return {
    ok: true,
    spreadsheet_id: id,
    sheet_name: tab,
    range: json.range || "",
    values: Array.isArray(json.values) ? json.values : []
  };
}

export async function getSpreadsheetTabs({ spreadsheetId } = {}) {
  const id = clean_(spreadsheetId);
  if (!id) throw new Error("spreadsheetId is required.");

  const token = await getGoogleDriveAccessToken();
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(id)}?fields=sheets(properties(title,sheetId,index,hidden,gridProperties(rowCount,columnCount)))`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Google Sheets metadata returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (!response.ok) {
    throw new Error(`Google Sheets metadata failed. HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  return (json.sheets || []).map((sheet) => sheet.properties || {}).filter((sheet) => sheet.title);
}

export function rowsToObjects(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const headers = (values[0] || []).map((header, index) => clean_(header) || `Column_${index + 1}`);
  return values.slice(1).map((row, rowIndex) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = row[index] ?? "";
    });
    return {
      row_number: rowIndex + 2,
      raw_values: row || [],
      named_values: object
    };
  });
}
