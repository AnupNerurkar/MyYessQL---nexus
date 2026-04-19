const cron = require('node-cron');
const nodemailer = require('nodemailer');
const db = require('../db');

// Configuration (Stale if not looked at for 2 days)
const STALE_THRESHOLD_DAYS = 2; 
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CRON_SCHEDULE = IS_PRODUCTION ? '0 0 * * *' : '*/5 * * * *'; // Every 24h (midnight) in prod, every 5m in dev
const THRESHOLD_VAL = IS_PRODUCTION ? `${STALE_THRESHOLD_DAYS} days` : '5 minutes';

// Email transport configuration (using Ethereal for testing/demo)
// In production, use SendGrid/SMTP settings from .env
const createTransport = async () => {
  // Check if real SMTP credentials are provided in .env
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // Use an "App Password" for Gmail
      },
    });
  }

  // Fallback to Ethereal for testing if no credentials provided
  let testAccount = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
};

const sendReminderEmail = async (request, authorityEmails) => {
  const transporter = await createTransport();

  const stageLabels = {
    librarian: 'Librarian (Library)',
    accounts: 'Accounts Department',
    lab_incharge: 'Lab Incharge (Laboratory)',
    hod: 'Head of Department (Hostel/Dept)',
    principal: 'Principal (Examination Cell)'
  };

  const subject = `Reminder: Pending Clearance Request Requires Your Attention [ID: ${request.id}]`;
  const body = `
    <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
      <h2 style="color: #0A1628;">Clearance Action Required</h2>
      <p>This is a gentle reminder that a clearance request assigned to your role (<strong>${stageLabels[request.current_stage]}</strong>) has not been reviewed for over ${THRESHOLD_VAL}.</p>
      
      <div style="background: #f8fafc; padding: 15px; border-radius: 6px; border: 1px solid #e2e8f0; margin: 20px 0;">
        <p style="margin: 0;"><strong>Student Name:</strong> ${request.student_name}</p>
        <p style="margin: 5px 0 0 0;"><strong>Roll Number/ID:</strong> ${request.student_id}</p>
        <p style="margin: 5px 0 0 0;"><strong>Application ID:</strong> # ${request.id}</p>
      </div>

      <p>Kindly log in to the NEXUS dashboard and take necessary action to avoid further delays in the clearance process.</p>
      
      <a href="http://localhost:3000/staff" style="display: inline-block; background: #2563EB; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold; margin-top: 10px;">Review Request</a>
      
      <p style="font-size: 12px; color: #64748B; margin-top: 30px;">
        This is an automated system notification from NEXUS. Please do not reply to this email.
      </p>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: '"NEXUS System" <noreply@nexus.dev>',
      to: authorityEmails.join(', '),
      subject: subject,
      html: body,
    });

    console.log(`[Reminder Service] Email sent to ${authorityEmails.join(', ')}: ${nodemailer.getTestMessageUrl(info)}`);
    return true;
  } catch (error) {
    console.error(`[Reminder Service] Failed to send email:`, error);
    return false;
  }
};

const detectStaleRequests = async () => {
  console.log(`[Reminder Service] Checking for stale requests...`);
  
  const query = `
    SELECT 
      cr.*, 
      u.name as student_name, 
      u.email as student_email
    FROM clearance_requests cr
    JOIN users u ON cr.student_id = u.id
    WHERE cr.status IN ('pending', 'in_progress')
    AND cr.updated_at < datetime('now', '-${THRESHOLD_VAL}')
    AND (cr.reminder_sent_flag = 0 OR cr.reminder_count < 1) -- Limit to 1 reminder for testing
  `;

  const staleRequests = db.prepare(query).all();
  
  if (staleRequests.length === 0) {
    console.log(`[Reminder Service] No stale requests detected.`);
    return;
  }

  console.log(`[Reminder Service] Found ${staleRequests.length} stale requests.`);

  for (const req of staleRequests) {
    // Identify authority emails for the current stage
    const authorities = db.prepare('SELECT email FROM users WHERE role = ?').all(req.current_stage);
    const emails = authorities.map(a => a.email);

    if (emails.length === 0) {
      console.warn(`[Reminder Service] No authorities found for role: ${req.current_stage}`);
      continue;
    }

    const sent = await sendReminderEmail(req, emails);
    
    if (sent) {
      db.prepare(`
        UPDATE clearance_requests 
        SET reminder_sent_flag = 1, 
            reminder_count = reminder_count + 1, 
            last_reminder_sent_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(req.id);
      console.log(`[Reminder Service] Updated request #${req.id} with reminder info.`);
    }
  }
};

const start = () => {
  console.log(`[Reminder Service] Started (Threshold: ${THRESHOLD_VAL}, Schedule: ${CRON_SCHEDULE})`);
  
  // Run based on configured schedule
  cron.schedule(CRON_SCHEDULE, () => {
    detectStaleRequests();
  });
};

module.exports = { start, detectStaleRequests };
