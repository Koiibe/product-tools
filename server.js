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
  auth: process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY,
});

// Database IDs
const PRODUCT_WORKFLOWS_DB_ID = '263ce8f7317a804dad72cac4e8a5aa60';
const STORIES_DB_ID = '1c1ce8f7317a80dfafc4d95c8cb67c3e';

// Store recent debug messages
let debugMessages = [];
const MAX_DEBUG_MESSAGES = 50;

function addDebugMessage(message) {
  debugMessages.push({
    timestamp: new Date().toISOString(),
    message: message
  });
  if (debugMessages.length > MAX_DEBUG_MESSAGES) {
    debugMessages.shift();
  }
}

// Webhook endpoint for Notion button
app.post('/webhook/notion', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    // Extract epic ID from webhook payload - try multiple formats
    // Notion buttons can send data in various formats
    let epicId = req.body.epicId;

    // FIRST: Check if the triggering page has an epic relation in its properties
    if (!epicId && req.body.data?.properties) {
      const epicProps = req.body.data.properties;

      // Check for common epic relation property names
      const epicRelation = epicProps['Epic'] ||
                          epicProps['Parent Epic'] ||
                          epicProps['📚 Epics All Teams'] ||
                          epicProps['Related Epic'];

      if (epicRelation?.relation?.[0]?.id) {
        epicId = epicRelation.relation[0].id;
        console.log('🎯 Found epic ID in relation property:', epicId);
      } else if (epicRelation?.rollup?.[0]?.relation?.[0]?.id) {
        epicId = epicRelation.rollup[0].relation[0].id;
        console.log('🎯 Found epic ID in rollup relation:', epicId);
      }
    }

    // SECOND: Check headers for epic ID (in case it's sent there)
    if (!epicId && req.headers.epicid && req.headers.epicid !== '{{page.id}}') {
      epicId = req.headers.epicid;
      console.log('🎯 Found epic ID in headers:', epicId);
    }

    // THIRD: Fallback to the triggering page ID (current page)
    if (!epicId) {
      epicId = req.body.data?.id ||  // Notion automation sends page ID here
               req.body.page?.id ||
               req.body.pageId ||
               req.body.id ||
               req.body.context?.pageId ||
               req.body.automationContext?.pageId;
      console.log('📄 Using triggering page ID as epic ID:', epicId);
    }

    console.log('🎯 Final extracted epicId:', epicId);
    
    if (!epicId) {
      console.log('No epic ID found in payload');
      return res.status(400).json({ 
        error: 'No epic ID provided in webhook. Please ensure the button passes the page ID.',
        receivedPayload: req.body,
        suggestion: 'Add a custom property with key "epicId" and value "{{page.id}}" to the webhook configuration'
      });
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

// Debug endpoint to see recent logs
app.get('/debug', (req, res) => {
  res.json({
    message: 'Recent debug messages',
    timestamp: new Date().toISOString(),
    apiKey: process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY ? 'Set' : 'Missing',
    apiKeyFormat: (() => {
      const key = process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY;
      if (!key) return 'No key';
      const isSecret = key.startsWith('secret_');
      const isNtn = key.startsWith('ntn_');
      return isSecret ? 'secret_ format' : isNtn ? 'ntn_ format' : 'Invalid format';
    })(),
    apiKeyLength: (process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY || '').length,
    recentMessages: debugMessages.slice(-10) // Show last 10 messages
  });
});

// Test epic retrieval endpoint
app.get('/test-epic/:epicId', async (req, res) => {
  try {
    const epicId = req.params.epicId;
    console.log(`Testing epic retrieval for ID: ${epicId}`);

    const epicDetails = await getEpicDetails(epicId);
    res.json({
      success: true,
      epicDetails: epicDetails,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test epic retrieval error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Main processing function
async function processWorkflowCopy(epicId) {
  try {
    console.log(`Processing workflow copy for epic: ${epicId}`);
    addDebugMessage(`Starting workflow copy for epic: ${epicId}`);

    // Step 1: Get epic details
    addDebugMessage(`Retrieving epic details for ID: ${epicId}`);
    const epicDetails = await getEpicDetails(epicId);
    console.log('Epic details:', epicDetails);
    addDebugMessage(`Epic details retrieved: ${JSON.stringify(epicDetails)}`);

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
    console.log(`Retrieving epic details for ID: ${epicId}`);
    const response = await notion.pages.retrieve({ page_id: epicId });
    console.log('Epic response received:', JSON.stringify(response.properties, null, 2));

    // Get the fulfill by property (adjust property name as needed)
    const fulfillByProperty = response.properties['Fulfill By'] || response.properties['Due Date'];

    let fulfillBy = null;
    if (fulfillByProperty && fulfillByProperty.date) {
      fulfillBy = new Date(fulfillByProperty.date.start);
      console.log(`Found fulfill by date: ${fulfillBy}`);
    }

    // Try different property names for the epic name
    let epicName = 'Unnamed Epic'; // fallback

    if (response.properties.Name?.title?.[0]?.plain_text) {
      epicName = response.properties.Name.title[0].plain_text;
      console.log(`Found epic name from Name.title: "${epicName}"`);
    } else if (response.properties.Name?.rich_text?.[0]?.plain_text) {
      epicName = response.properties.Name.rich_text[0].plain_text;
      console.log(`Found epic name from Name.rich_text: "${epicName}"`);
    } else if (response.properties.Title?.title?.[0]?.plain_text) {
      epicName = response.properties.Title.title[0].plain_text;
      console.log(`Found epic name from Title.title: "${epicName}"`);
    } else {
      console.log('Epic name not found, using fallback. Available properties:', Object.keys(response.properties));
    }

    return {
      id: epicId,
      name: epicName,
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

// Get database schema to understand what properties exist
async function getDatabaseSchema(databaseId) {
  try {
    const database = await notion.databases.retrieve({ database_id: databaseId });
    return Object.keys(database.properties);
  } catch (error) {
    console.error(`Error getting database schema for ${databaseId}:`, error.message);
    return [];
  }
}

// Clean properties for Notion API and filter for target database schema
function cleanPropertiesForAPI(properties, allowedProperties = []) {
  const cleanedProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!value) continue;

    // Skip properties that don't exist in target database (but allow Title and Name for mapping)
    if (allowedProperties.length > 0 && !allowedProperties.includes(key) && key !== 'Title' && key !== 'Name') {
      console.log(`Skipping property '${key}' - not found in target database schema`);
      continue;
    }

    // Handle people properties - clean user objects to only include ID
    if (value.people && Array.isArray(value.people)) {
      cleanedProperties[key] = {
        people: value.people.map(person => ({
          id: person.id
        }))
      };
    }
    // Handle other property types normally
    else {
      cleanedProperties[key] = value;
    }
  }

  return cleanedProperties;
}

// Copy pages to Stories database with translations
async function copyPagesToStories(workflowPages, epicDetails, dateTranslation) {
  const copiedPages = [];
  
  // Get Stories database schema to know which properties are allowed
  console.log('Getting Stories database schema...');
  const storiesSchema = await getDatabaseSchema(STORIES_DB_ID);
  console.log('Stories database properties:', storiesSchema);

  for (const workflowPage of workflowPages) {
    try {
      // Prepare new page properties and clean them for API
      // Keep the Name property for title mapping, even if it's not in target schema
      const rawProperties = { ...workflowPage.properties };
      const newProperties = cleanPropertiesForAPI(rawProperties, storiesSchema);

      // Handle title mapping - source has 'Name', target has 'Title'
      let originalTitle = '';

      // Debug: Log what properties are available
      const pageProps = Object.keys(workflowPage.properties);
      addDebugMessage(`Page ${workflowPage.id} properties: [${pageProps.join(', ')}]`);
      console.log(`Page properties for ${workflowPage.id}:`, pageProps);

      if (newProperties.Name && newProperties.Name.title) {
        originalTitle = newProperties.Name.title[0]?.plain_text || '';
        addDebugMessage(`Found Name property with title: "${originalTitle}"`);
        console.log(`Found Name property with title: "${originalTitle}"`);
        // Remove the Name property since target doesn't have it
        delete newProperties.Name;
      } else if (newProperties.Name && newProperties.Name.rich_text) {
        // Try rich_text format
        originalTitle = newProperties.Name.rich_text[0]?.plain_text || '';
        addDebugMessage(`Found Name property with rich_text: "${originalTitle}"`);
        console.log(`Found Name property with rich_text: "${originalTitle}"`);
        delete newProperties.Name;
      } else {
        addDebugMessage(`No Name property found or unexpected format: ${JSON.stringify(newProperties.Name)}`);
        console.log('No Name property found or it has unexpected format:', newProperties.Name);
      }

      // Create Title property with epic prefix
      if (originalTitle) {
        newProperties.Title = {
          title: [{
            text: {
              content: `${epicDetails.name}: ${originalTitle}`
            }
          }]
        };
        addDebugMessage(`Created Title property: "${epicDetails.name}: ${originalTitle}"`);
        console.log(`Created Title property: "${epicDetails.name}: ${originalTitle}"`);
      } else {
        // Fallback: create a generic title if no name was found
        newProperties.Title = {
          title: [{
            text: {
              content: `${epicDetails.name}: Workflow Task`
            }
          }]
        };
        addDebugMessage(`Created fallback Title property: "${epicDetails.name}: Workflow Task"`);
        console.log(`Created fallback Title property: "${epicDetails.name}: Workflow Task"`);
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
  const apiKey = process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY;
  console.log('Notion API Key:', apiKey ? 'Set' : 'Missing');
  if (apiKey) {
    const isValidFormat = apiKey.startsWith('secret_') || apiKey.startsWith('ntn_');
    console.log('API Key format check:', isValidFormat ? 'Valid format' : 'Invalid format - should start with secret_ or ntn_');
    console.log('API Key length:', apiKey.length);
  }
});

module.exports = app;
