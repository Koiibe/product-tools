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

    // Extract multiple epic IDs, target date, and workflow types from webhook payload
    // New format: single row with multi-select workflows and multiple epic relations
    let epicId = req.body.epicId; // Fallback for backward compatibility
    let webhookTargetDate = req.body.targetDate || req.body.fulfillBy;
    let selectedWorkflows = req.body.workflows || req.body.Workflows || [];

    // Extract epic relations for each workflow type
    let batchEpicId = req.body.batchEpic || req.body['Batch Epic'];
    let skuEpicId = req.body.skuEpic || req.body['SKU Epic'];
    let marketEpicId = req.body.marketEpic || req.body['Market Epic'];

    // FIRST: Extract data from triggering page properties (new format)
    if (req.body.data?.properties) {
      const generatorProps = req.body.data.properties;

      // Extract target date from triggering page properties if not in webhook
      if (!webhookTargetDate) {
        const targetDateProp = generatorProps['Target date'] ||
                              generatorProps['Target Date'] ||
                              generatorProps['Fulfill By'] ||
                              generatorProps['Fulfill by'] ||
                              generatorProps['Due Date'] ||
                              generatorProps['Due'] ||
                              generatorProps['Deadline'];

        if (targetDateProp?.date?.start) {
          webhookTargetDate = targetDateProp.date.start;
          console.log('📅 Found target date in triggering page properties:', webhookTargetDate);
        }
      }

      // Extract selected workflows from multi-select property
      if (!selectedWorkflows.length) {
        const workflowsProp = generatorProps['Workflows'] ||
                             generatorProps['workflows'] ||
                             generatorProps['Workflow'];

        if (workflowsProp?.multi_select) {
          selectedWorkflows = workflowsProp.multi_select.map(item => item.name);
          console.log('🔄 Found selected workflows:', selectedWorkflows);
        } else if (workflowsProp?.select?.name) {
          selectedWorkflows = [workflowsProp.select.name];
          console.log('🔄 Found single workflow:', selectedWorkflows);
        }
      }

      // Extract epic relations for each workflow type
      if (!batchEpicId) {
        const batchEpicProp = generatorProps['Batch Epic'] ||
                             generatorProps['batchEpic'] ||
                             generatorProps['Batch'];

        if (batchEpicProp?.relation?.[0]?.id) {
          batchEpicId = batchEpicProp.relation[0].id;
          console.log('🎯 Found Batch Epic ID:', batchEpicId);
        }
      }

      if (!skuEpicId) {
        const skuEpicProp = generatorProps['SKU Epic'] ||
                           generatorProps['skuEpic'] ||
                           generatorProps['SKU'];

        if (skuEpicProp?.relation?.[0]?.id) {
          skuEpicId = skuEpicProp.relation[0].id;
          console.log('🎯 Found SKU Epic ID:', skuEpicId);
        }
      }

      if (!marketEpicId) {
        const marketEpicProp = generatorProps['Market Epic'] ||
                              generatorProps['marketEpic'] ||
                              generatorProps['Market'];

        if (marketEpicProp?.relation?.[0]?.id) {
          marketEpicId = marketEpicProp.relation[0].id;
          console.log('🎯 Found Market Epic ID:', marketEpicId);
        }
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

    console.log('🎯 Extracted data:');
    console.log('  - Selected workflows:', selectedWorkflows);
    console.log('  - Target date:', webhookTargetDate);
    console.log('  - Batch Epic:', batchEpicId);
    console.log('  - SKU Epic:', skuEpicId);
    console.log('  - Market Epic:', marketEpicId);

    // Validate that selected workflows have corresponding epic relations
    const workflowEpicMap = {
      'New batch': batchEpicId,
      'Batch': batchEpicId,
      'batch': batchEpicId,
      'New SKU': skuEpicId,
      'SKU': skuEpicId,
      'sku': skuEpicId,
      'New Market': marketEpicId,
      'Market': marketEpicId,
      'market': marketEpicId
    };

    const missingEpics = [];
    selectedWorkflows.forEach(workflow => {
      if (!workflowEpicMap[workflow]) {
        missingEpics.push(workflow);
      }
    });

    if (missingEpics.length > 0) {
      console.log('❌ Missing epic relations for workflows:', missingEpics);
      return res.status(400).json({
        error: `Missing epic relations for selected workflows: ${missingEpics.join(', ')}`,
        receivedPayload: req.body,
        suggestion: 'Please set the corresponding epic relation properties for the selected workflows'
      });
    }

    if (selectedWorkflows.length === 0) {
      console.log('❌ No workflows selected');
      return res.status(400).json({
        error: 'No workflows selected. Please select at least one workflow.',
        receivedPayload: req.body,
        suggestion: 'Select workflows using the "Workflows" multi-select property'
      });
    }

    // Process multiple workflows
    const workflowConfigs = selectedWorkflows.map(workflow => ({
      type: workflow,
      epicId: workflowEpicMap[workflow],
      name: workflow
    }));

    await processMultipleWorkflows(workflowConfigs, webhookTargetDate);

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
async function processWorkflowCopy(epicId, webhookTargetDate = null, workflowType = null) {
  try {
    console.log(`Processing workflow copy for epic: ${epicId}`);
    addDebugMessage(`Starting workflow copy for epic: ${epicId}`);

    // Step 1: Get epic details
    addDebugMessage(`Retrieving epic details for ID: ${epicId}`);
    const epicDetails = await getEpicDetails(epicId);
    console.log('Epic details:', epicDetails);
    addDebugMessage(`Epic details retrieved: ${JSON.stringify(epicDetails)}`);

    // Use webhook target date if epic doesn't have one
    let effectiveTargetDate = epicDetails.fulfillBy; // Note: keeping fulfillBy for now, will update epic property extraction later
    if (!effectiveTargetDate && webhookTargetDate) {
      effectiveTargetDate = new Date(webhookTargetDate);
      console.log('📅 Using webhook target date:', effectiveTargetDate);
      addDebugMessage(`Using webhook target date: ${effectiveTargetDate}`);
    } else if (effectiveTargetDate) {
      console.log('📅 Using epic target date:', effectiveTargetDate);
      addDebugMessage(`Using epic target date: ${effectiveTargetDate}`);
    } else {
      console.log('⚠️ No target date found - dates will not be translated');
      addDebugMessage('No target date found - dates will not be translated');
    }

    // Step 2: Get workflow pages filtered by workflow type
    const workflowPages = await getWorkflowPages(workflowType);
    console.log(`Found ${workflowPages.length} workflow pages${workflowType ? ` for workflow type: ${workflowType}` : ''}`);

    // Step 3: Calculate date translation
    const dateTranslation = calculateDateTranslation(workflowPages, effectiveTargetDate);

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

    // Get the target date property - try multiple property names
    let fulfillBy = null;
    const targetDateCandidates = [
      'Target date',     // New primary name
      'Target Date',     // Alternative casing
      'Fulfill By',      // Legacy name
      'Fulfill by',      // Legacy different casing
      'Due Date',        // Alternative name
      'Due',             // Short form
      'Deadline',        // Alternative name
      'End Date',        // Alternative name
      'Completion Date'  // Alternative name
    ];

    for (const propName of targetDateCandidates) {
      const prop = response.properties[propName];
      if (prop?.date?.start) {
        fulfillBy = new Date(prop.date.start);
        console.log(`📅 Found target date from ${propName}: ${fulfillBy}`);
        break; // Use the first one found
      }
    }

    if (!fulfillBy) {
      console.log('⚠️ No target date property found. Available properties:', Object.keys(response.properties));
    }

    // Try different property names for the epic name
    let epicName = 'Unnamed Epic'; // fallback

    // Check for common epic name property variations
    const epicNameCandidates = [
      'Name',           // Standard name property
      'Epic Name',      // Custom epic name property
      'Title',          // Title property
      'Page'            // Page property
    ];

    for (const propName of epicNameCandidates) {
      const prop = response.properties[propName];
      if (prop) {
        // Try different formats: title, rich_text
        if (prop.title?.[0]?.plain_text) {
          epicName = prop.title[0].plain_text;
          console.log(`🎯 Found epic name from ${propName}.title: "${epicName}"`);
          break;
        } else if (prop.rich_text?.[0]?.plain_text) {
          epicName = prop.rich_text[0].plain_text;
          console.log(`🎯 Found epic name from ${propName}.rich_text: "${epicName}"`);
          break;
        }
      }
    }

    if (epicName === 'Unnamed Epic') {
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
async function getWorkflowPages(workflowType = null) {
  try {
    const queryParams = {
      database_id: PRODUCT_WORKFLOWS_DB_ID,
      sorts: [
        {
          property: 'Date',
          direction: 'ascending',
        },
      ],
    };

    // If workflow type is specified, filter by workflow select property (not relation)
    if (workflowType) {
      queryParams.filter = {
        property: 'Workflow',
        select: {
          equals: workflowType
        }
      };
      console.log(`🔄 Filtering workflow pages by workflow type: ${workflowType}`);
    }

    const response = await notion.databases.query(queryParams);

    return response.results.map(page => ({
      id: page.id,
      properties: page.properties,
      date: page.properties.Date?.date?.start ? new Date(page.properties.Date.date.start) : null,
      icon: page.icon, // Include icon information for copying
    }));
  } catch (error) {
    console.error('Error getting workflow pages:', error);
    throw new Error(`Failed to get workflow pages: ${error.message}`);
  }
}

// Process multiple workflows sequentially
async function processMultipleWorkflows(workflowConfigs, targetDate) {
  console.log(`🚀 Processing ${workflowConfigs.length} workflows`);

  const results = [];
  for (const config of workflowConfigs) {
    try {
      console.log(`\n▶️ Processing workflow: ${config.name} (Epic: ${config.epicId})`);
      const result = await processWorkflowCopy(config.epicId, targetDate, config.type);
      results.push({ workflow: config.name, success: true, pagesCopied: result });
    } catch (error) {
      console.error(`❌ Failed to process workflow ${config.name}:`, error);
      results.push({ workflow: config.name, success: false, error: error.message });
    }
  }

  const successful = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`\n📊 Completed: ${successful}/${total} workflows successful`);

  return results;
}

// Calculate date translation to maintain relational distance
function calculateDateTranslation(workflowPages, epicFulfillBy) {
  if (!epicFulfillBy || workflowPages.length === 0) {
    console.log('📅 No fulfill by date or no workflow pages - no translation');
    return { offset: 0 };
  }

  // Find the latest date in workflow pages
  const pagesWithDates = workflowPages.filter(page => page.date);
  console.log(`📅 Found ${pagesWithDates.length} workflow pages with dates out of ${workflowPages.length} total`);

  if (pagesWithDates.length === 0) {
    console.log('📅 No workflow pages have dates - no translation');
    return { offset: 0 };
  }

  const latestWorkflowDate = pagesWithDates.reduce((latest, page) => page.date > latest ? page.date : latest, new Date(0));
  console.log(`📅 Latest workflow date: ${latestWorkflowDate.toISOString().split('T')[0]}`);
  console.log(`📅 Epic fulfill by date: ${epicFulfillBy.toISOString().split('T')[0]}`);

  // Calculate offset to align latest workflow date with epic fulfill by date
  const offset = epicFulfillBy.getTime() - latestWorkflowDate.getTime();
  const offsetDays = Math.round(offset / (1000 * 60 * 60 * 24));

  console.log(`📅 Date translation offset: ${offsetDays} days`);

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
    // Also skip the "Workflow" property as it's only used for filtering templates
    if (allowedProperties.length > 0 && !allowedProperties.includes(key) && key !== 'Title' && key !== 'Name' && key !== 'Workflow') {
      console.log(`Skipping property '${key}' - not found in target database schema`);
      continue;
    }

    // Explicitly skip the Workflow property since it's only used for filtering templates
    if (key === 'Workflow') {
      console.log(`Skipping property 'Workflow' - not needed in target database`);
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

      // Debug: Log what properties and metadata are available
      const pageProps = Object.keys(workflowPage.properties);
      addDebugMessage(`Page ${workflowPage.id} properties: [${pageProps.join(', ')}]`);
      console.log(`Page properties for ${workflowPage.id}:`, pageProps);

      // Debug: Check for icon in the source page
      if (workflowPage.icon) {
        addDebugMessage(`Source page ${workflowPage.id} has icon: ${JSON.stringify(workflowPage.icon)}`);
        console.log(`🎨 Source page has icon:`, workflowPage.icon);
      } else {
        addDebugMessage(`Source page ${workflowPage.id} has no icon`);
        console.log(`🎨 Source page has no icon`);
      }

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

      // Prepare page creation parameters
      const pageParams = {
        parent: { database_id: STORIES_DB_ID },
        properties: newProperties,
      };

      // Copy icon from source page if it exists
      if (workflowPage.icon) {
        pageParams.icon = workflowPage.icon;
        addDebugMessage(`Copying icon from source page: ${JSON.stringify(workflowPage.icon)}`);
        console.log(`📎 Copying icon from source page:`, workflowPage.icon);
      }

      // Create new page in Stories database
      const newPage = await notion.pages.create(pageParams);

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
