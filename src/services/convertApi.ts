/* eslint-disable @typescript-eslint/no-explicit-any */
import ConvertApi from 'convertapi';
import { config } from '../config/environment.js';
import type { ConvertedFile } from '../types/index.js';
import { convertApiCircuit } from './circuitBreaker.js';

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
  // Wrapped in circuit breaker (TD-05)
  const result = await convertApiCircuit.execute<{ files: any[] }>(() =>
    client.convert(
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
    )
  );

  // Get the converted file
  const file = result.files[0];
  if (!file) {
    throw new Error('ConvertAPI did not return a converted file');
  }

  // Store the durable URL for potential retries
  const pdfUrl = file.url as string;
  console.log('ConvertAPI PDF URL (durable for retries):', pdfUrl);

  // Fetch the file data
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to download converted PDF: ${response.statusText}`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  // Generate PDF filename from the safe filename
  const pdfFilename = safeFilename.replace(/\.eml$/i, '.pdf');

  return {
    filename: pdfFilename,
    data,
    url: pdfUrl,  // Include durable URL for retry scenarios
  };
}

/**
 * Download PDF from a previously generated ConvertAPI URL
 * Used for retry scenarios where we don't want to reconvert
 */
export async function downloadPdfFromUrl(url: string): Promise<Buffer> {
  console.log('Downloading PDF from stored URL:', url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF from URL: ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
  const client = getClient();

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

  console.log('Converting HTML to PDF:', htmlFilename, htmlContent.length, 'chars');

  // Convert HTML to PDF using the convertapi library
  // Wrapped in circuit breaker (TD-05)
  const result = await convertApiCircuit.execute<{ files: any[] }>(() =>
    client.convert(
      'pdf',
      {
        File: { name: htmlFilename, data: Buffer.from(htmlContent, 'utf-8') },
        PageSize: 'a4',
        MarginTop: 10,
        MarginRight: 10,
        MarginBottom: 10,
        MarginLeft: 10,
        PageOrientation: 'portrait',
      },
      'html'
    )
  );

  // Get the converted file
  const file = result.files[0];
  if (!file) {
    throw new Error('ConvertAPI did not return a converted file');
  }

  // Store the durable URL for potential retries
  const pdfUrl = file.url as string;
  console.log('ConvertAPI PDF URL:', pdfUrl);

  // Fetch the file data
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to download converted PDF: ${response.statusText}`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  return {
    filename: pdfFilename,
    data,
    url: pdfUrl,
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
  // Escape HTML entities
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

  // Build minimal HTML
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.4; padding: 20px; }
    .header { border-bottom: 1px solid #ccc; padding-bottom: 10px; margin-bottom: 20px; }
    .header h1 { font-size: 16pt; margin: 0 0 10px 0; }
    .header .meta { color: #666; font-size: 10pt; }
    .body { white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(subject)}</h1>
    <div class="meta">
      ${from ? `<div>From: ${escapeHtml(from)}</div>` : ''}
      <div>Date: ${date.toLocaleString('en-US', { timeZone: 'America/New_York' })}</div>
    </div>
  </div>
  <div class="body">${escapeHtml(textContent)}</div>
</body>
</html>`;

  return convertHtmlToPdf(html, subject.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50));
}
