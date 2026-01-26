/**
 * ConvertAPI Service
 *
 * PDF conversion via core-api
 * - EML to PDF
 * - HTML to PDF
 * - Plain text to PDF
 *
 * Migrated to use core-api instead of direct ConvertAPI SDK
 */

import type { ConvertedFile } from '../types/index.js';
import { convertApiCircuit } from './circuitBreaker.js';
import { convertApi as coreApiConvert } from './coreApi.js';

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

  console.log('Converting EML to PDF via core-api:', safeFilename, safeContent.length, 'bytes');

  // Convert EML to PDF via core-api
  // Wrapped in circuit breaker (TD-05)
  const result = await convertApiCircuit.execute(() =>
    coreApiConvert.emlToPdf({
      emlContent: safeContent.toString('base64'),
      filename: safeFilename,
    })
  );

  console.log('ConvertAPI PDF URL (durable for retries):', result.url);

  // Generate PDF filename from the safe filename
  const pdfFilename = safeFilename.replace(/\.eml$/i, '.pdf');

  return {
    filename: result.filename || pdfFilename,
    data: Buffer.from(result.data, 'base64'),
    url: result.url,
  };
}

/**
 * Download PDF from a previously generated ConvertAPI URL
 * Used for retry scenarios where we don't want to reconvert
 */
export async function downloadPdfFromUrl(url: string): Promise<Buffer> {
  console.log('Downloading PDF from stored URL via core-api:', url);
  return coreApiConvert.downloadPdf(url);
}

/**
 * Convert HTML content to PDF
 * Used for /emailtask to create PDFs from Gmail email bodies
 *
 * @param htmlContent - The HTML content to convert
 * @param filename - Output filename (without extension)
 * @returns The converted PDF file
 */
export async function convertHtmlToPdf(
  htmlContent: string,
  filename: string = 'email'
): Promise<ConvertedFile> {
  // Validate inputs
  if (typeof htmlContent !== 'string') {
    throw new Error(`htmlContent must be a string, got ${typeof htmlContent}`);
  }
  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string, got ${typeof filename}`);
  }

  // Ensure filename is clean and doesn't have extension
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseFilename = safeFilename.replace(/\.(html?|pdf)$/i, '') || 'email';
  const htmlFilename = `${baseFilename}.html`;
  const pdfFilename = `${baseFilename}.pdf`;

  console.log('Converting HTML to PDF via core-api:', htmlFilename, htmlContent.length, 'chars');

  // Convert HTML to PDF via core-api
  // Wrapped in circuit breaker (TD-05)
  const result = await convertApiCircuit.execute(() =>
    coreApiConvert.htmlToPdf({
      htmlContent,
      filename: htmlFilename,
    })
  );

  console.log('ConvertAPI PDF URL:', result.url);

  return {
    filename: result.filename || pdfFilename,
    data: Buffer.from(result.data, 'base64'),
    url: result.url,
  };
}

/**
 * Convert plain text to PDF (fallback when no HTML available)
 * Wraps text in minimal HTML structure
 *
 * @param textContent - The plain text content
 * @param subject - Email subject for the title
 * @param from - Sender info
 * @param date - Email date
 * @returns The converted PDF file
 */
export async function convertTextToPdf(
  textContent: string,
  subject: string,
  from: string | null,
  date: Date
): Promise<ConvertedFile> {
  console.log('Converting text to PDF via core-api:', subject);

  // Convert text to PDF via core-api
  // Wrapped in circuit breaker (TD-05)
  const result = await convertApiCircuit.execute(() =>
    coreApiConvert.textToPdf({
      textContent,
      subject,
      from: from || undefined,
      date: date.toISOString(),
    })
  );

  console.log('ConvertAPI PDF URL:', result.url);

  return {
    filename: result.filename,
    data: Buffer.from(result.data, 'base64'),
    url: result.url,
  };
}
