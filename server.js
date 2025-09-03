const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Client } = require('@notionhq/client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize Notion client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// Database IDs
const PRODUCT_WORKFLOWS_DB_ID = '263ce8f7317a804dad72cac4e8a5aa60';
const STORIES_DB_ID = '1c1ce8f7317a80dfafc4d95c8cb67c3e';

// Webhook endpoint for Notion button
app.post('/webhook/notion', async (req, res) => {
  try {
    console.log('Received webhook:', req.body);

    // Extract epic ID from webhook payload
    const epicId = req.body.epicId || req.body.page?.id;
    if (!epicId) {
      return res.status(400).json({ error: 'No epic ID provided in webhook' });
    }

    // Process the workflow copying
    await processWorkflowCopy(epicId);

    res.status(200).json({ message: 'Workflow processing completed successfully' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Main processing function
async function processWorkflowCopy(epicId) {
  try {
    console.log(`Processing workflow copy for epic: ${epicId}`);

    // Step 1: Get epic details
    const epicDetails = await getEpicDetails(epicId);
    console.log('Epic details:', epicDetails);

    // Step 2: Get all pages from Product Workflows database
    const workflowPages = await getWorkflowPages();
    console.log(`Found ${workflowPages.length} workflow pages`);

    // Step 3: Calculate date translation
    const dateTranslation = calculateDateTranslation(workflowPages, epicDetails.fulfillBy);

    // Step 4: Copy pages to Stories database
    const copiedPages = await copyPagesToStories(workflowPages, epicDetails, dateTranslation);

    console.log(`Successfully copied ${copiedPages.length} pages to Stories database`);
    return copiedPages;
  } catch (error) {
    console.error('Error in processWorkflowCopy:', error);
    throw error;
  }
}

// Get epic details including fulfill by date
async function getEpicDetails(epicId) {
  try {
    const response = await notion.pages.retrieve({ page_id: epicId });

    // Get the fulfill by property (adjust property name as needed)
    const fulfillByProperty = response.properties['Fulfill By'] || response.properties['Due Date'];

    let fulfillBy = null;
    if (fulfillByProperty && fulfillByProperty.date) {
      fulfillBy = new Date(fulfillByProperty.date.start);
    }

    return {
      id: epicId,
      name: response.properties.Name?.title?.[0]?.plain_text || 'Unnamed Epic',
      fulfillBy: fulfillBy
    };
  } catch (error) {
    console.error('Error getting epic details:', error);
    throw new Error(`Failed to get epic details: ${error.message}`);
  }
}

// Get all pages from Product Workflows database
async function getWorkflowPages() {
  try {
    const response = await notion.databases.query({
      database_id: PRODUCT_WORKFLOWS_DB_ID,
      sorts: [
        {
          property: 'Date',
          direction: 'ascending',
        },
      ],
    });

    return response.results.map(page => ({
      id: page.id,
      properties: page.properties,
      date: page.properties.Date?.date?.start ? new Date(page.properties.Date.date.start) : null,
    }));
  } catch (error) {
    console.error('Error getting workflow pages:', error);
    throw new Error(`Failed to get workflow pages: ${error.message}`);
  }
}

// Calculate date translation to maintain relational distance
function calculateDateTranslation(workflowPages, epicFulfillBy) {
  if (!epicFulfillBy || workflowPages.length === 0) {
    return { offset: 0 };
  }

  // Find the latest date in workflow pages
  const latestWorkflowDate = workflowPages
    .filter(page => page.date)
    .reduce((latest, page) => page.date > latest ? page.date : latest, new Date(0));

  if (latestWorkflowDate.getTime() === 0) {
    return { offset: 0 };
  }

  // Calculate offset to align latest workflow date with epic fulfill by date
  const offset = epicFulfillBy.getTime() - latestWorkflowDate.getTime();

  return { offset };
}

// Copy pages to Stories database with translations
async function copyPagesToStories(workflowPages, epicDetails, dateTranslation) {
  const copiedPages = [];

  for (const workflowPage of workflowPages) {
    try {
      // Prepare new page properties
      const newProperties = { ...workflowPage.properties };

      // Add epic name as prefix to title
      if (newProperties.Name && newProperties.Name.title) {
        const originalTitle = newProperties.Name.title[0]?.plain_text || '';
        newProperties.Name.title[0] = {
          ...newProperties.Name.title[0],
          plain_text: `${epicDetails.name}: ${originalTitle}`,
        };
      }

      // Translate dates
      if (newProperties.Date && newProperties.Date.date && workflowPage.date) {
        const translatedDate = new Date(workflowPage.date.getTime() + dateTranslation.offset);
        newProperties.Date.date.start = translatedDate.toISOString().split('T')[0];
      }

      // Add relation to original epic
      if (!newProperties.Epic) {
        newProperties.Epic = {
          relation: [{ id: epicDetails.id }]
        };
      }

      // Create new page in Stories database
      const newPage = await notion.pages.create({
        parent: { database_id: STORIES_DB_ID },
        properties: newProperties,
      });

      copiedPages.push(newPage);
      console.log(`Created page: ${newPage.id}`);
    } catch (error) {
      console.error(`Error copying page ${workflowPage.id}:`, error);
      // Continue with other pages even if one fails
    }
  }

  return copiedPages;
}

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Notion API Key:', process.env.NOTION_API_KEY ? 'Set' : 'Missing');
});

module.exports = app;
