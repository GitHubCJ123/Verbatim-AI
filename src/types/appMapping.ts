/**
 * App mapping types — extends the schema from plan §7.
 */

export interface AppMapping {
  id: string;
  appExecutable: string;        // 'slack.exe' (case-insensitive match)
  appDisplayName: string;       // 'Slack'
  appIconPath: string | null;   // future: extracted via Win32 SHGetFileInfo
  modeId: string | null;
  matchWindowTitle: string | null; // optional regex source
  createdAt: string;
}
