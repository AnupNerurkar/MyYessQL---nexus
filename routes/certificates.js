const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const generator = require('../services/generator');

// 1. Trigger generation for an approved request
router.post('/generate/:requestId', authenticate, async (req, res) => {
    const { requestId } = req.params;
    const userId = req.user.id;

    try {
        // Auth check: Only student who owns it or Principal can trigger
        const request = db.prepare('SELECT student_id, status FROM clearance_requests WHERE id = ?').get(requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        
        if (req.user.role === 'student' && request.student_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (request.status !== 'approved') {
            return res.status(400).json({ error: 'Clearance must be fully approved by Principal' });
        }

        // Check if already generated
        const existing = db.prepare('SELECT certificate_id FROM certificates WHERE request_id = ?').all(requestId);
        if (existing.length > 0) {
            return res.json({ 
                message: 'Documents already generated', 
                certificates: existing 
            });
        }

        const result = await generator.generateStudentBundle(requestId);
        res.json({
            message: 'Digital bundle generated successfully',
            ...result
        });

    } catch (err) {
        console.error('Generation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Public verification endpoint
router.get('/verify/:certificateId', (req, res) => {
    const { certificateId } = req.params;

    const cert = db.prepare(`
        SELECT c.*, u.name as student_name, u.email as student_email 
        FROM certificates c
        JOIN users u ON c.student_id = u.id
        WHERE c.certificate_id = ?
    `).get(certificateId);

    if (!cert) {
        return res.status(404).json({ valid: false, message: 'Certificate not found or invalid' });
    }

    res.json({
        valid: true,
        certificate_id: cert.certificate_id,
        type: cert.type,
        student_name: cert.student_name,
        issued_at: cert.issued_at,
        institution: 'Nexus University',
        status: 'Authentic Document'
    });
});

// 3. Download certificate
router.get('/download/:certificateId', authenticate, (req, res) => {
    const { certificateId } = req.params;
    const userId = req.user.id;

    const cert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(certificateId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    // Auth check
    if (req.user.role === 'student' && cert.student_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const filePath = path.join(__dirname, '..', cert.file_path);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(filePath);
});

// 4. Get student certificates
router.get('/my-bundle', authenticate, (req, res) => {
    const userId = req.user.id;
    const certs = db.prepare('SELECT certificate_id, type, issued_at FROM certificates WHERE student_id = ?').all(userId);
    res.json(certs);
});

module.exports = router;
