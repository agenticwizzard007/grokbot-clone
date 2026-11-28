import { Code2, FileText, File, Table2, Image, Braces } from 'lucide-react';
export function artifactKind(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['html', 'htm'].includes(ext)) return { key: 'web', label: 'Web page', extension: 'HTML', Icon: Code2 };
  if (['csv', 'xlsx', 'xls'].includes(ext)) return { key: 'data', label: 'Spreadsheet', extension: ext.toUpperCase(), Icon: Table2 };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { key: 'image', label: 'Image', extension: ext.toUpperCase(), Icon: Image };
  if (['json', 'js', 'ts', 'tsx', 'jsx', 'py', 'css', 'yaml', 'yml', 'sql', 'xml'].includes(ext)) return { key: 'code', label: 'Code', extension: ext.toUpperCase(), Icon: Braces };
  if (['md', 'txt', 'pdf', 'doc', 'docx'].includes(ext)) return { key: 'document', label: 'Document', extension: ext.toUpperCase(), Icon: FileText };
  return { key: 'file', label: 'File', extension: ext.toUpperCase().slice(0, 8), Icon: File };
}
export const artifactTitle = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';
