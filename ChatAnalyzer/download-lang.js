const { createWorker } = require('tesseract.js');

(async () => {
  try {
    console.log('Downloading Tesseract language data...');
    const worker = await createWorker('eng');
    console.log('Language data downloaded successfully!');
    await worker.terminate();
  } catch (error) {
    console.error('Error downloading language data:', error);
    process.exit(1);
  }
})(); 