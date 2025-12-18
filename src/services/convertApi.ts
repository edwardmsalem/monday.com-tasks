/* eslint-disable @typescript-eslint/no-explicit-any */
import ConvertApi from 'convertapi';
import { config } from '../config/environment.js';
import type { ConvertedFile } from '../types/index.js';

// ConvertApi doesn't have proper TypeScript definitions
let convertApiClient: any = null;

function getClient(): any {
  if (!convertApiClient) {
    convertApiClient = new (ConvertApi as any)(config.convertApi.secret);
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

  // Ensure filename is a string (Make.com can send objects)
  let safeFilename = 'email.eml';
  if (typeof filename === 'string' && filename) {
    safeFilename = filename;
  } else if (filename && typeof filename === 'object') {
    const nameObj = filename as unknown as Record<string, unknown>;
    if (typeof nameObj.name === 'string') {
      safeFilename = nameObj.name;
    } else if (typeof nameObj.filename === 'string') {
      safeFilename = nameObj.filename;
    }
  }

  // Ensure filename ends with .eml
  if (!safeFilename.toLowerCase().endsWith('.eml')) {
    safeFilename = safeFilename + '.eml';
  }

  // Ensure content is a Buffer
  let safeContent = emlContent;
  if (!Buffer.isBuffer(emlContent)) {
    if (typeof emlContent === 'string') {
      safeContent = Buffer.from(emlContent);
    } else if (emlContent && typeof emlContent === 'object') {
      // Try to handle if it's an object with data property
      const contentObj = emlContent as unknown as Record<string, unknown>;
      if (Buffer.isBuffer(contentObj.data)) {
        safeContent = contentObj.data as Buffer;
      } else if (typeof contentObj.data === 'string') {
        safeContent = Buffer.from(contentObj.data as string, 'base64');
      } else {
        throw new Error('EML content is not a valid Buffer');
      }
    }
  }

  console.log('Converting EML to PDF:', safeFilename, safeContent.length, 'bytes');

  // Convert EML to PDF using the convertapi library
  const result = await client.convert(
    'pdf',
    {
      File: { name: safeFilename, data: safeContent },
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

  // Generate PDF filename from the safe filename
  const pdfFilename = safeFilename.replace(/\.eml$/i, '.pdf');

  return {
    filename: pdfFilename,
    data,
  };
}
