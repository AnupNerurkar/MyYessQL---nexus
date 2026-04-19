const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const QRCode = require('qrcode');
const db = require('../db');

// Cache for compiled templates
const templateCache = {};

function getTemplate(name) {
    if (templateCache[name]) return templateCache[name];
    const templatePath = path.join(__dirname, '../templates', `${name}.html`);
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    const compiled = handlebars.compile(templateHtml);
    templateCache[name] = compiled;
    return compiled;
}

/**
 * Generates a PDF using an existing browser instance
 */
async function generatePDFWithBrowser(browser, templateName, data, outputPath) {
    const template = getTemplate(templateName);
    const html = template(data);

    let page;
    try {
        console.log(`[Generator] Creating new page for ${templateName}...`);
        page = await browser.newPage();
        
        // Set a reasonable timeout for the page
        page.setDefaultNavigationTimeout(60000);
        
        console.log(`[Generator] Setting content for ${templateName}...`);
        // Using 'load' instead of 'domcontentloaded' to be safer with fonts
        await page.setContent(html, { waitUntil: 'load' });
        
        // Ensure fonts/styles are applied
        await page.evaluateHandle('document.fonts.ready');

        console.log(`[Generator] Generating PDF for ${templateName}...`);
        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
        });
        console.log(`[Generator] PDF saved to ${outputPath}`);
    } catch (err) {
        console.error(`[Generator] Error during ${templateName} generation:`, err);
        throw err;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

function generateCertId() {
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 90000) + 10000;
    return `NEXUS-${year}-${random}`;
}

async function generateStudentBundle(requestId) {
    console.log(`[Generator] Starting bundle generation for request ${requestId}`);
    
    // 1. Fetch request details
    const request = db.prepare(`
        SELECT cr.*, u.name as student_name, u.email as student_email 
        FROM clearance_requests cr
        JOIN users u ON cr.student_id = u.id
        WHERE cr.id = ?
    `).get(requestId);

    if (!request) throw new Error('Request not found');
    if (request.status !== 'approved') throw new Error('Request must be approved');

    // 2. Prepare Data
    const records = db.prepare('SELECT * FROM academic_records WHERE student_id = ? ORDER BY semester ASC').all(request.student_id);
    const semesters = [];
    const semestersMap = {};
    records.forEach(r => {
        if (!semestersMap[r.semester]) {
            semestersMap[r.semester] = { semesterNumber: r.semester, courses: [] };
            semesters.push(semestersMap[r.semester]);
        }
        semestersMap[r.semester].courses.push(r);
    });

    const totalCredits = records.reduce((sum, r) => sum + r.credits, 0);
    const cgpa = 8.75; 
    const issueDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    const academicYear = "2023 - 2024";

    // 3. Launch browser with pipe: true to avoid WS endpoint timeout
    console.log('[Generator] Launching browser...');
    const browser = await puppeteer.launch({
        headless: true, // Use default stable headless
        pipe: true,     // Communicate via pipe instead of WebSocket (fixes the WS endpoint timeout)
        timeout: 120000, // 2 minutes for very slow systems
        dumpio: true,   
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--font-render-hinting=none',
            '--disable-web-security'
        ]
    });

    try {
        const certUniqueId = generateCertId();
        const transcriptUniqueId = generateCertId();
        const certPath = path.join(__dirname, '../certificates', `clearance_${certUniqueId}.pdf`);
        const transcriptPath = path.join(__dirname, '../certificates', `transcript_${transcriptUniqueId}.pdf`);
        const verifyUrlBase = process.env.APP_URL || 'http://localhost:3000';
        
        const qrDataUrl = await QRCode.toDataURL(`${verifyUrlBase}/verify/${certUniqueId}`, { 
            margin: 1, color: { dark: '#0A1628', light: '#FFFFFF' } 
        });

        // 4. Generate sequentially
        await generatePDFWithBrowser(browser, 'certificate', {
            studentName: request.student_name,
            rollNumber: `NEX-${String(request.student_id).padStart(4, '0')}`,
            programName: "Bachelor of Technology",
            department: request.department || "Information Technology",
            academicYear, issueDate,
            clearanceDate: new Date(request.updated_at).toLocaleDateString(),
            certificateId: certUniqueId,
            verifyUrl: `${verifyUrlBase}/verify/${certUniqueId}`,
            qrCode: qrDataUrl,
            hostelCleared: true
        }, certPath);

        await generatePDFWithBrowser(browser, 'transcript', {
            studentName: request.student_name,
            rollNumber: `NEX-${String(request.student_id).padStart(4, '0')}`,
            programName: "Bachelor of Technology",
            department: request.department || "Information Technology",
            batch: "2020 - 2024",
            transcriptId: transcriptUniqueId,
            semesters, totalCredits, cgpa, classification: "First Class with Distinction", issueDate,
            verifyUrl: `${verifyUrlBase}/verify/${transcriptUniqueId}`
        }, transcriptPath);

        // 5. DB updates
        db.transaction(() => {
            db.prepare(`INSERT INTO certificates (request_id, student_id, certificate_id, type, file_path) VALUES (?, ?, ?, 'clearance', ?)`).run(
                requestId, request.student_id, certUniqueId, `certificates/clearance_${certUniqueId}.pdf`
            );
            db.prepare(`INSERT INTO certificates (request_id, student_id, certificate_id, type, file_path) VALUES (?, ?, ?, 'transcript', ?)`).run(
                requestId, request.student_id, transcriptUniqueId, `certificates/transcript_${transcriptUniqueId}.pdf`
            );
        })();

        console.log(`[Generator] Bundle for request ${requestId} completed successfully.`);
        return { clearance_id: certUniqueId, transcript_id: transcriptUniqueId };

    } catch (err) {
        console.error('[Generator] Fatal bundle generation error:', err);
        throw err;
    } finally {
        if (browser) {
            console.log('[Generator] Closing browser...');
            await browser.close().catch(() => {});
        }
    }
}

module.exports = {
    generateStudentBundle
};
