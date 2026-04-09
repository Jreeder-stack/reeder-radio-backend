import { Router } from 'express';
import { getAudioLogs, getDistinctUnits, getDistinctChannels, getAudioDataByFilename } from '../db/index.js';
import { requireDispatcher } from '../middleware/auth.js';
import PDFDocument from 'pdfkit';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';

const router = Router();
const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');

function formatDuration(ms) {
  if (!ms) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function applyOffset(date, tzOffsetMinutes) {
  const d = new Date(date);
  if (tzOffsetMinutes !== null && tzOffsetMinutes !== undefined && !isNaN(tzOffsetMinutes)) {
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
    return new Date(utcMs + tzOffsetMinutes * 60000);
  }
  return d;
}

function formatDateForFilename(date, tzOffset) {
  const d = applyOffset(date, tzOffset);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`;
}

function formatTimeForFilename(date, tzOffset) {
  const d = applyOffset(date, tzOffset);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTimeForFilenameWithSeconds(date, tzOffset) {
  const d = applyOffset(date, tzOffset);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatMilitaryTime(date, tzOffset) {
  const d = applyOffset(date, tzOffset);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateStr(date, tzOffset) {
  const d = applyOffset(date, tzOffset);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

router.get('/filters', requireDispatcher, async (req, res) => {
  try {
    const [units, channels] = await Promise.all([
      getDistinctUnits(),
      getDistinctChannels()
    ]);
    res.json({ success: true, units, channels });
  } catch (error) {
    console.error('Error fetching filter options:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function validateDateParam(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return undefined;
  return val;
}

router.get('/search', requireDispatcher, async (req, res) => {
  try {
    const { channels, units, from, to, limit, offset } = req.query;
    const parsedChannels = channels ? channels.split(',').filter(Boolean) : null;
    const parsedUnits = units ? units.split(',').filter(Boolean) : null;
    let parsedLimit = parseInt(limit) || 100;
    let parsedOffset = parseInt(offset) || 0;
    if (parsedLimit < 1) parsedLimit = 1;
    if (parsedLimit > 500) parsedLimit = 500;
    if (parsedOffset < 0) parsedOffset = 0;

    const validFrom = validateDateParam(from);
    const validTo = validateDateParam(to);
    if (validFrom === undefined || validTo === undefined) {
      return res.status(400).json({ success: false, error: 'Invalid date format' });
    }

    const { rows, total } = await getAudioLogs({
      channels: parsedChannels,
      units: parsedUnits,
      from: validFrom,
      to: validTo,
      limit: parsedLimit,
      offset: parsedOffset
    });

    const enrichedRows = rows.map(row => {
      if (!row.audio_available && row.audio_url) {
        const filename = row.audio_url.split('/').pop();
        const filepath = path.join(AUDIO_DIR, filename);
        if (fs.existsSync(filepath)) {
          return { ...row, audio_available: true };
        }
      }
      return row;
    });

    res.json({ success: true, logs: enrichedRows, total });
  } catch (error) {
    console.error('Error searching audio logs:', error);
    res.status(500).json({ success: false, error: 'Failed to search audio logs' });
  }
});

router.get('/export/pdf', requireDispatcher, async (req, res) => {
  try {
    const { channels, units, from, to, tz } = req.query;
    const parsedChannels = channels ? channels.split(',').filter(Boolean) : null;
    const parsedUnits = units ? units.split(',').filter(Boolean) : null;
    const tzOffset = tz ? parseInt(tz) : null;

    const { rows } = await getAudioLogs({
      channels: parsedChannels,
      units: parsedUnits,
      from: from || null,
      to: to || null,
      limit: 100000,
      offset: 0
    });

    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="transmission_log_${Date.now()}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text('Transmission Log', { align: 'center' });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#666');
    if (from || to) {
      const fromStr = from ? `${formatDateStr(from, tzOffset)} ${formatMilitaryTime(from, tzOffset)}` : 'Start';
      const toStr = to ? `${formatDateStr(to, tzOffset)} ${formatMilitaryTime(to, tzOffset)}` : 'Now';
      doc.text(`Date Range: ${fromStr} - ${toStr}`, { align: 'center' });
    }
    if (parsedChannels && parsedChannels.length > 0) {
      doc.text(`Channels: ${parsedChannels.join(', ')}`, { align: 'center' });
    }
    if (parsedUnits && parsedUnits.length > 0) {
      doc.text(`Units: ${parsedUnits.join(', ')}`, { align: 'center' });
    }
    doc.text(`Total Transmissions: ${rows.length}`, { align: 'center' });
    doc.moveDown(1);

    doc.fillColor('#000');

    const tableTop = doc.y;
    const colWidths = [80, 50, 100, 100, 60];
    const colHeaders = ['Date', 'Time', 'Unit', 'Channel', 'Length'];
    const colX = [50, 130, 180, 280, 380];

    doc.fontSize(9).font('Helvetica-Bold');
    colHeaders.forEach((header, i) => {
      doc.text(header, colX[i], tableTop, { width: colWidths[i] });
    });
    doc.moveTo(50, tableTop + 15).lineTo(460, tableTop + 15).stroke('#ccc');

    doc.font('Helvetica').fontSize(8);
    let y = tableTop + 20;

    for (const row of rows) {
      if (y > 700) {
        doc.addPage();
        y = 50;
        doc.fontSize(9).font('Helvetica-Bold');
        colHeaders.forEach((header, i) => {
          doc.text(header, colX[i], y, { width: colWidths[i] });
        });
        doc.moveTo(50, y + 15).lineTo(460, y + 15).stroke('#ccc');
        doc.font('Helvetica').fontSize(8);
        y += 20;
      }

      const dateStr = formatDateStr(row.created_at, tzOffset);
      const timeStr = formatMilitaryTime(row.created_at, tzOffset);
      const duration = formatDuration(row.audio_duration);

      doc.text(dateStr, colX[0], y, { width: colWidths[0] });
      doc.text(timeStr, colX[1], y, { width: colWidths[1] });
      doc.text(row.sender || '-', colX[2], y, { width: colWidths[2] });
      doc.text(row.channel || '-', colX[3], y, { width: colWidths[3] });
      doc.text(duration, colX[4], y, { width: colWidths[4] });

      y += 15;
    }

    doc.end();
  } catch (error) {
    console.error('Error generating PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to generate PDF' });
    }
  }
});

router.get('/export/zip', requireDispatcher, async (req, res) => {
  try {
    const { channels, units, from, to, tz } = req.query;
    const parsedChannels = channels ? channels.split(',').filter(Boolean) : null;
    const parsedUnits = units ? units.split(',').filter(Boolean) : null;
    const tzOffset = tz ? parseInt(tz) : null;

    const { rows } = await getAudioLogs({
      channels: parsedChannels,
      units: parsedUnits,
      from: from || null,
      to: to || null,
      limit: 100000,
      offset: 0
    });

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No audio messages found' });
    }

    const fromDate = from ? new Date(from) : new Date(rows[rows.length - 1].created_at);
    const toDate = to ? new Date(to) : new Date(rows[0].created_at);
    const channelLabel = parsedChannels && parsedChannels.length === 1 ? parsedChannels[0] : 'All';

    const folderName = `${formatDateForFilename(fromDate, tzOffset)}_${formatTimeForFilename(fromDate, tzOffset)}hrs-${formatTimeForFilename(toDate, tzOffset)}hrs_${channelLabel}`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    const pdfDoc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const pdfChunks = [];
    pdfDoc.on('data', chunk => pdfChunks.push(chunk));

    await new Promise((resolve) => {
      pdfDoc.on('end', resolve);

      pdfDoc.fontSize(18).text('Transmission Log', { align: 'center' });
      pdfDoc.moveDown(0.5);
      pdfDoc.fontSize(10).fillColor('#666');
      const fromStr = `${formatDateStr(fromDate, tzOffset)} ${formatMilitaryTime(fromDate, tzOffset)}`;
      const toStr = `${formatDateStr(toDate, tzOffset)} ${formatMilitaryTime(toDate, tzOffset)}`;
      pdfDoc.text(`Date Range: ${fromStr} - ${toStr}`, { align: 'center' });
      if (parsedChannels) pdfDoc.text(`Channels: ${parsedChannels.join(', ')}`, { align: 'center' });
      if (parsedUnits) pdfDoc.text(`Units: ${parsedUnits.join(', ')}`, { align: 'center' });
      pdfDoc.text(`Total Transmissions: ${rows.length}`, { align: 'center' });
      pdfDoc.moveDown(1);
      pdfDoc.fillColor('#000');

      const colHeaders = ['Date', 'Time', 'Unit', 'Channel', 'Length'];
      const colX = [50, 130, 180, 280, 380];
      const colWidths = [80, 50, 100, 100, 60];

      let y = pdfDoc.y;
      pdfDoc.fontSize(9).font('Helvetica-Bold');
      colHeaders.forEach((header, i) => {
        pdfDoc.text(header, colX[i], y, { width: colWidths[i] });
      });
      pdfDoc.moveTo(50, y + 15).lineTo(460, y + 15).stroke('#ccc');
      pdfDoc.font('Helvetica').fontSize(8);
      y += 20;

      for (const row of rows) {
        if (y > 700) {
          pdfDoc.addPage();
          y = 50;
          pdfDoc.fontSize(9).font('Helvetica-Bold');
          colHeaders.forEach((header, i) => {
            pdfDoc.text(header, colX[i], y, { width: colWidths[i] });
          });
          pdfDoc.moveTo(50, y + 15).lineTo(460, y + 15).stroke('#ccc');
          pdfDoc.font('Helvetica').fontSize(8);
          y += 20;
        }
        const dateStr = formatDateStr(row.created_at, tzOffset);
        const timeStr = formatMilitaryTime(row.created_at, tzOffset);
        const duration = formatDuration(row.audio_duration);
        pdfDoc.text(dateStr, colX[0], y, { width: colWidths[0] });
        pdfDoc.text(timeStr, colX[1], y, { width: colWidths[1] });
        pdfDoc.text(row.sender || '-', colX[2], y, { width: colWidths[2] });
        pdfDoc.text(row.channel || '-', colX[3], y, { width: colWidths[3] });
        pdfDoc.text(duration, colX[4], y, { width: colWidths[4] });
        y += 15;
      }

      pdfDoc.end();
    });

    const pdfBuffer = Buffer.concat(pdfChunks);
    const pdfFilename = `${formatDateForFilename(fromDate, tzOffset)}_${formatTimeForFilename(fromDate, tzOffset)} log.pdf`;
    archive.append(pdfBuffer, { name: `${folderName}/${pdfFilename}` });

    const usedFilenames = new Set();
    for (const msg of rows) {
      if (!msg.audio_url) continue;
      const originalFilename = msg.audio_url.split('/').pop();

      let baseName = `${formatDateForFilename(msg.created_at, tzOffset)}_${formatTimeForFilename(msg.created_at, tzOffset)}`;
      let newFilename = `${baseName}.wav`;
      if (usedFilenames.has(newFilename)) {
        baseName = `${formatDateForFilename(msg.created_at, tzOffset)}_${formatTimeForFilenameWithSeconds(msg.created_at, tzOffset)}`;
        newFilename = `${baseName}.wav`;
        let counter = 2;
        while (usedFilenames.has(newFilename)) {
          newFilename = `${baseName}_${counter}.wav`;
          counter++;
        }
      }

      const audioData = await getAudioDataByFilename(originalFilename);
      if (audioData) {
        usedFilenames.add(newFilename);
        archive.append(audioData, { name: `${folderName}/${newFilename}` });
      } else {
        const filepath = path.join(AUDIO_DIR, originalFilename);
        if (fs.existsSync(filepath)) {
          usedFilenames.add(newFilename);
          archive.file(filepath, { name: `${folderName}/${newFilename}` });
        }
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error exporting ZIP:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to generate ZIP export' });
    }
  }
});

export default router;
