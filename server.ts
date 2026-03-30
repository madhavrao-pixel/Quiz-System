import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const PORT = 3000;

// In-memory state
interface Question {
  id: string;
  text: string;
  options: string[];
  correctOptionIndex: number;
  timeLimit: number;
}

interface Participant {
  socketId: string;
  name: string;
  rollNumber: string;
  score: number;
  answers: Record<string, number>;
  joinedAt: number;
}

interface QuizSession {
  id: string;
  title: string;
  questions: Question[];
  status: 'waiting' | 'active' | 'finished';
  currentQuestionIndex: number;
  participants: Record<string, Participant>;
  teacherSocketId: string;
  questionStartTime?: number;
  questionTimer?: NodeJS.Timeout;
}

const sessions: Record<string, QuizSession> = {};

// Helper to generate a short 6-character code
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Teacher creates a quiz
  socket.on('create_quiz', (data: { title: string; questions: Omit<Question, 'id'>[] }, callback) => {
    const sessionId = generateCode();
    const questions = data.questions.map((q) => ({ ...q, id: uuidv4() }));
    
    sessions[sessionId] = {
      id: sessionId,
      title: data.title,
      questions,
      status: 'waiting',
      currentQuestionIndex: -1,
      participants: {},
      teacherSocketId: socket.id,
    };

    socket.join(`teacher_${sessionId}`);
    callback({ success: true, sessionId });
  });

  // Student joins a quiz
  socket.on('join_quiz', (data: { sessionId: string; name: string; rollNumber: string }, callback) => {
    const session = sessions[data.sessionId];
    if (!session) {
      return callback({ success: false, error: 'Quiz not found' });
    }
    if (session.status !== 'waiting') {
      return callback({ success: false, error: 'Quiz has already started or finished' });
    }

    const participant: Participant = {
      socketId: socket.id,
      name: data.name,
      rollNumber: data.rollNumber,
      score: 0,
      answers: {},
      joinedAt: Date.now(),
    };

    session.participants[socket.id] = participant;
    socket.join(`student_${data.sessionId}`);

    // Notify teacher
    io.to(`teacher_${data.sessionId}`).emit('participant_joined', Object.values(session.participants));

    callback({ success: true, session: { id: session.id, title: session.title } });
  });

  // Teacher starts the quiz
  socket.on('start_quiz', (sessionId: string) => {
    const session = sessions[sessionId];
    if (session && session.teacherSocketId === socket.id) {
      session.status = 'active';
      session.currentQuestionIndex = 0;
      sendQuestion(session);
    }
  });

  // Teacher moves to next question
  socket.on('next_question', (sessionId: string) => {
    const session = sessions[sessionId];
    if (session && session.teacherSocketId === socket.id) {
      if (session.currentQuestionIndex < session.questions.length - 1) {
        session.currentQuestionIndex++;
        sendQuestion(session);
      } else {
        endQuiz(session);
      }
    }
  });

  // Teacher ends quiz early
  socket.on('end_quiz', (sessionId: string) => {
    const session = sessions[sessionId];
    if (session && session.teacherSocketId === socket.id) {
      endQuiz(session);
    }
  });

  // Student submits an answer
  socket.on('submit_answer', (data: { sessionId: string; questionId: string; optionIndex: number }) => {
    const session = sessions[data.sessionId];
    if (!session || session.status !== 'active') return;

    const participant = session.participants[socket.id];
    if (!participant) return;

    const currentQuestion = session.questions[session.currentQuestionIndex];
    if (currentQuestion.id !== data.questionId) return;

    // Prevent multiple answers for the same question
    if (participant.answers[currentQuestion.id] !== undefined) return;

    participant.answers[currentQuestion.id] = data.optionIndex;

    if (data.optionIndex === currentQuestion.correctOptionIndex) {
      // Simple scoring: 100 points for correct answer
      participant.score += 100;
    }

    // Notify teacher of updated participant stats
    io.to(`teacher_${data.sessionId}`).emit('participant_updated', Object.values(session.participants));
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Handle cleanup if necessary, but for now we keep the participant in the session
    // to preserve their score and attendance.
  });
});

function sendQuestion(session: QuizSession) {
  if (session.questionTimer) {
    clearTimeout(session.questionTimer);
  }

  const question = session.questions[session.currentQuestionIndex];
  session.questionStartTime = Date.now();

  // Send question to students (without correct option)
  const studentQuestion = {
    id: question.id,
    text: question.text,
    options: question.options,
    timeLimit: question.timeLimit,
    index: session.currentQuestionIndex,
    total: session.questions.length,
  };

  io.to(`student_${session.id}`).emit('new_question', studentQuestion);
  io.to(`teacher_${session.id}`).emit('current_question', { ...studentQuestion, correctOptionIndex: question.correctOptionIndex });

  // Set timer to automatically end question
  session.questionTimer = setTimeout(() => {
    io.to(`student_${session.id}`).emit('question_timeout', { questionId: question.id });
    io.to(`teacher_${session.id}`).emit('question_timeout', { questionId: question.id });
  }, question.timeLimit * 1000);
}

function endQuiz(session: QuizSession) {
  if (session.questionTimer) {
    clearTimeout(session.questionTimer);
  }
  session.status = 'finished';
  const participantsList = Object.values(session.participants).sort((a, b) => b.score - a.score);
  
  io.to(`student_${session.id}`).emit('quiz_finished', participantsList);
  io.to(`teacher_${session.id}`).emit('quiz_finished', participantsList);
}

async function startServer() {
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
