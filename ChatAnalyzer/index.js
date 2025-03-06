require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { createWorker, createScheduler } = require('tesseract.js');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Verify API key is present
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

const app = express();
const port = 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Created uploads directory');
}

// Middleware setup (move all middleware to the top)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    status: 'error',
    message: err.message || 'Internal server error',
    error: {
      type: err.name,
      details: err.message,
      timestamp: new Date().toISOString()
    }
  });
});

// Configure multer with error handling
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Ensure uploads directory exists
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
}).single('image');

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Server is running' });
});

// File upload route with enhanced error handling
app.post('/upload', (req, res) => {
  upload(req, res, async function(err) {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(400).json({
        status: 'error',
        message: 'File upload error',
        error: {
          type: 'MulterError',
          details: err.message,
          timestamp: new Date().toISOString()
        }
      });
    } else if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({
        status: 'error',
        message: err.message,
        error: {
          type: err.name,
          details: err.message,
          timestamp: new Date().toISOString()
        }
      });
    }

    // No file uploaded
    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'No image file provided'
      });
    }

    let worker = null;
    try {
      console.log('Processing file:', req.file.originalname);

      // Verify file exists and is readable
      await fs.promises.access(req.file.path, fs.constants.R_OK);
      
      // Extract text using Tesseract with v6 API
      console.log('Initializing Tesseract...');
      worker = await createWorker('eng');
      
      console.log('Starting OCR process...');
      const { data } = await worker.recognize(req.file.path);
      console.log('OCR completed. Text length:', data.text.length);
      
      if (!data.text.trim()) {
        await worker.terminate();
        return res.status(400).json({
          status: 'error',
          message: 'No text could be extracted from the image'
        });
      }

      // Store the extracted text
      const extractedText = data.text;
      
      // Analyze text using OpenAI
      console.log('Starting OpenAI analysis...');
      const completion = await openai.chat.completions.create({
        messages: [
          { 
            role: "system", 
            content: `You are an expert text analyzer. Analyze the provided text and return a JSON response with the following structure:
            {
              "summary": "A brief summary of the text",
              "keyPoints": ["Array of key points extracted"],
              "sentiment": "Overall sentiment (positive/negative/neutral)",
              "topics": ["Main topics identified"],
              "language": "Primary language detected",
              "confidence": "High/Medium/Low based on text clarity"
            }`
          },
          {
            role: "user",
            content: extractedText
          }
        ],
        model: "gpt-3.5-turbo",
        response_format: { type: "json_object" }
      });

      const analysis = JSON.parse(completion.choices[0].message.content);

      res.json({
        status: 'success',
        message: 'Image processed successfully',
        data: {
          file: {
            name: req.file.originalname,
            path: req.file.path,
            size: req.file.size
          },
          textExtraction: {
            raw: extractedText,
            wordCount: extractedText.trim().split(/\s+/).length,
            characterCount: extractedText.length
          },
          analysis: {
            ...analysis,
            timestamp: new Date().toISOString()
          }
        }
      });
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Error processing image',
        error: {
          type: error.name,
          details: error.message,
          timestamp: new Date().toISOString()
        }
      });
    } finally {
      if (worker) {
        await worker.terminate();
      }
    }
  });
});

// Add chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { question, analysisContext } = req.body;

    if (!question || !analysisContext) {
      return res.status(400).json({
        status: 'error',
        message: 'Question and analysis context are required'
      });
    }

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant analyzing text. You have access to the following analysis context:
          - Extracted Text: ${analysisContext.textExtraction.raw}
          - Summary: ${analysisContext.analysis.summary}
          - Sentiment: ${analysisContext.analysis.sentiment}
          - Topics: ${analysisContext.analysis.topics.join(', ')}
          - Language: ${analysisContext.analysis.language}
          
          Provide concise, specific answers based on this analysis.`
        },
        {
          role: "user",
          content: question
        }
      ],
      model: "gpt-3.5-turbo",
    });

    res.json({
      status: 'success',
      response: completion.choices[0].message.content
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Error processing chat request',
      error: error.message
    });
  }
});

// Add ask endpoint with enhanced analysis
app.post('/ask', async (req, res) => {
  try {
    const { question, analysisContext } = req.body;

    if (!question || !analysisContext) {
      return res.status(400).json({
        status: 'error',
        message: 'Question and analysis context are required'
      });
    }

    console.log('Processing question:', question);
    
    // Check if analysisContext has the required properties
    if (!analysisContext.textExtraction || !analysisContext.analysis) {
      console.error('Invalid analysis context structure:', JSON.stringify(analysisContext, null, 2));
      return res.status(400).json({
        status: 'error',
        message: 'Invalid analysis context structure'
      });
    }

    // Enhanced system prompt for more detailed analysis
    const systemPrompt = `You are an expert text analyzer providing detailed insights. 
    Context of the analyzed text:
    - Full Text: ${analysisContext.textExtraction.raw || 'Not available'}
    - Summary: ${analysisContext.analysis.summary || 'Not available'}
    - Sentiment: ${analysisContext.analysis.sentiment || 'Not available'}
    - Topics: ${(analysisContext.analysis.topics && analysisContext.analysis.topics.join(', ')) || 'Not available'}
    - Language: ${analysisContext.analysis.language || 'Not available'}
    - Word Count: ${analysisContext.textExtraction.wordCount || 'Not available'}
    - Character Count: ${analysisContext.textExtraction.characterCount || 'Not available'}

    Provide a detailed response in JSON format with the following structure:
    {
      "answer": "Your main answer to the question",
      "evidence": ["Relevant quotes or examples from the text"],
      "confidence": "High/Medium/Low based on available information",
      "relatedTopics": ["Related topics from the analysis"],
      "suggestions": ["Optional suggestions for follow-up questions"]
    }

    You must respond with valid JSON that matches this structure.
    Base your analysis on the provided context and be specific in your responses.`;

    console.log('Sending request to OpenAI...');
    
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: question
        }
      ],
      model: "gpt-3.5-turbo",
      response_format: { type: "json_object" }
    });

    console.log('Received response from OpenAI');
    
    let analysis;
    try {
      analysis = JSON.parse(completion.choices[0].message.content);
      console.log('Successfully parsed JSON response');
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      console.error('Original response:', completion.choices[0].message.content);
      
      // Return a fallback response if parsing fails
      return res.json({
        status: 'success',
        timestamp: new Date().toISOString(),
        question: question,
        analysis: {
          answer: "I couldn't format the answer properly, but here's the raw response: " 
                  + completion.choices[0].message.content.substring(0, 500) + "...",
          evidence: [],
          confidence: "Low",
          relatedTopics: [],
          suggestions: ["Try asking a more specific question"]
        }
      });
    }

    return res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      question: question,
      analysis: analysis
    });
    
  } catch (error) {
    console.error('Error in /ask endpoint:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    
    return res.status(500).json({
      status: 'error',
      message: 'Error processing question',
      error: {
        type: error.name,
        message: error.message,
        timestamp: new Date().toISOString()
      }
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 