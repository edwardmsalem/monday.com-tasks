import ConvertApi from 'convertapi';
import { config } from '../config/environment.js';
import type { ConvertedFile } from '../types/index.js';

let convertApiClient: ConvertApi | null = null;

function getClient(): ConvertApi {
  if (!convertApiClient) {
    convertApiClient = new ConvertApi(config.convertApi.secret);
  }
  return convertApiClient;
}

/**
 * Convert an EML file to PDF
 * @param emlContent - The EML file content as a Buffer
 * @param filename - Original filename
 * @returns The converted PDF file
 */
export async function convertEmlToPdf(
  emlContent: Buffer,
  filename: string
): Promise<ConvertedFile> {
  const client = getClient();

  // Convert EML to PDF
  const result = await client.convert(
    'pdf',
    {
      File: new ConvertApi.FileParam(emlContent, filename),
      PageSize: 'a4',
      MarginTop: 5,
      MarginRight: 5,
      MarginBottom: 5,
      MarginLeft: 5,
      PageOrientation: 'portrait',
    },
    'eml'
  );

  // Get the converted file
  const file = result.files[0];
  if (!file) {
    throw new Error('ConvertAPI did not return a converted file');
  }

  // Fetch the file data
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Failed to download converted PDF: ${response.statusText}`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  // Generate PDF filename
  const pdfFilename = filename.replace(/\.eml$/i, '.pdf');

  return {
    filename: pdfFilename,
    data,
  };
}
