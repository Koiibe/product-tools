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

// Target template pages - the specific pages we want to copy
const TARGET_TEMPLATE_PAGES = [
  '263ce8f7317a80c4afa2fb66c2461e19'  // New target date page with all three epics
];

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
    console.log('🚀 Received webhook request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request headers:', JSON.stringify(req.headers, null, 2));

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
        const batchEpicProp = generatorProps['📚 Batch Epic'] ||
                             generatorProps['Batch Epic'] ||
                             generatorProps['batchEpic'] ||
                             generatorProps['Batch'];

        if (batchEpicProp?.relation?.[0]?.id) {
          batchEpicId = batchEpicProp.relation[0].id;
        }
      }

      if (!skuEpicId) {
        const skuEpicProp = generatorProps['📚 SKU Epic'] ||
                           generatorProps['SKU Epic'] ||
                           generatorProps['skuEpic'] ||
                           generatorProps['SKU'];

        if (skuEpicProp?.relation?.[0]?.id) {
          skuEpicId = skuEpicProp.relation[0].id;
        }
      }

      if (!marketEpicId) {
        const marketEpicProp = generatorProps['📚 Market Epic'] ||
                              generatorProps['Market Epic'] ||
                              generatorProps['marketEpic'] ||
                              generatorProps['Market'];

        if (marketEpicProp?.relation?.[0]?.id) {
          marketEpicId = marketEpicProp.relation[0].id;
        }
      }
    }

    // SECOND: Check headers for epic ID (in case it's sent there)
    if (!epicId && req.headers.epicid && req.headers.epicid !== '{{page.id}}') {
      epicId = req.headers.epicid;
    }

    // THIRD: Fallback to the triggering page ID (current page)
    if (!epicId) {
      epicId = req.body.data?.id ||  // Notion automation sends page ID here
               req.body.page?.id ||
               req.body.pageId ||
               req.body.id ||
               req.body.context?.pageId ||
               req.body.automationContext?.pageId;
    }

    console.log(`🎯 Webhook: ${selectedWorkflows.length} workflows, target=${webhookTargetDate || 'none'}, epics=[${[batchEpicId, skuEpicId, marketEpicId].filter(Boolean).join(', ')}]`);

    // Validate that selected workflows have corresponding epic relations
    const workflowEpicMap = {
      'New batch': batchEpicId,
      'Batch': batchEpicId,
      'batch': batchEpicId,
      'New Batch': batchEpicId,
      'new batch': batchEpicId,
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
    try {
      const workflowConfigs = selectedWorkflows.map(workflow => ({
        type: workflow,
        epicId: workflowEpicMap[workflow],
        name: workflow
      }));

      console.log('🔄 Processing workflows:', workflowConfigs.map(w => w.name));

      const results = await processMultipleWorkflows(workflowConfigs, webhookTargetDate);

      console.log('✅ Webhook processing completed successfully');
      res.status(200).json({
        message: 'Workflow processing completed successfully',
        results: results
      });
    } catch (processingError) {
      console.error('❌ Workflow processing failed:', processingError);
      res.status(500).json({
        error: 'Workflow processing failed',
        details: processingError.message,
        workflowType: selectedWorkflows
      });
    }
  } catch (webhookError) {
    console.error('❌ Webhook processing error:', webhookError);
    console.error('Error stack:', webhookError.stack);

    // Ensure we always return a proper response
    if (!res.headersSent) {
      res.status(400).json({
        error: 'Webhook processing failed',
        details: webhookError.message,
        receivedBody: req.body
      });
    }
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
async function processWorkflowCopy(epicId, webhookTargetDate = null, workflowType = null, allEpics = []) {
  try {
    // Validate epicId
    if (!epicId || typeof epicId !== 'string') {
      throw new Error(`Invalid epic ID: ${epicId}`);
    }

    // Step 1: Get epic details
    const epicDetails = await getEpicDetails(epicId);
    if (!epicDetails) {
      throw new Error(`Failed to retrieve epic details for ID: ${epicId}`);
    }

    // Use webhook target date if epic doesn't have one
    let effectiveTargetDate = epicDetails.fulfillBy;
    if (!effectiveTargetDate && webhookTargetDate) {
      effectiveTargetDate = new Date(webhookTargetDate);
    }

    // Step 2: Get workflow pages filtered by workflow type
    const workflowPages = await getWorkflowPages(workflowType);

    // Step 3: Calculate date translation
    const dateTranslation = calculateDateTranslation(workflowPages, effectiveTargetDate);

    // Step 4: Copy pages to Stories database
    const copyResult = await copyPagesToStories(workflowPages, epicDetails, dateTranslation, workflowType, allEpics);

    // Return detailed result for cross-workflow dependency resolution
    return {
      copiedPages: copyResult.copiedPages.length,
      templateToPageMap: copyResult.templateToPageMap,
      workflowPages: workflowPages
    };
  } catch (error) {
    console.error('Error in processWorkflowCopy:', error);
    throw error;
  }
}

// Get epic details including fulfill by date
async function getEpicDetails(epicId) {
  try {
    console.log(`🔍 Retrieving epic details for ID: ${epicId}`);

    if (!epicId || typeof epicId !== 'string') {
      throw new Error(`Invalid epic ID: ${epicId}`);
    }

    const response = await notion.pages.retrieve({ page_id: epicId });

    if (!response || !response.properties) {
      throw new Error('Invalid response from Notion API');
    }

    console.log('📋 Epic response received for properties:', Object.keys(response.properties));

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
    console.error('❌ Error getting epic details:', error.message);
    console.error('Error details:', error);

    // Provide more specific error messages
    if (error.code === 'unauthorized') {
      throw new Error('Notion API token is invalid or expired');
    } else if (error.code === 'not_found') {
      throw new Error(`Epic page not found. Please check the epic ID: ${epicId}`);
    } else if (error.code === 'validation_error') {
      throw new Error(`Invalid epic ID format: ${epicId}`);
    }

    throw new Error(`Failed to get epic details: ${error.message}`);
  }
}

// Get all pages from Product Workflows database
async function getWorkflowPages(workflowType = null) {
  try {
    // First, get all pages from the database to find relevant ones
    const queryParams = {
      database_id: PRODUCT_WORKFLOWS_DB_ID,
      sorts: [
        {
          property: 'Date',
          direction: 'ascending',
        },
      ],
    };

    // If workflow type is specified, filter by workflow multi_select property (not relation)
    if (workflowType) {
      queryParams.filter = {
        property: 'Workflow',
        multi_select: {
          contains: workflowType
        }
      };
      console.log(`🔄 Filtering workflow pages by workflow type: ${workflowType}`);
    }

    const response = await notion.databases.query(queryParams);

    let workflowPages = response.results.map(page => ({
      id: page.id,
      properties: page.properties,
      date: page.properties.Date?.date?.start ? new Date(page.properties.Date.date.start) : null,
      icon: page.icon, // Include icon information for copying
    }));

    // If workflow type is specified, also include the target template pages that might not have been captured by the filter
    if (workflowType && TARGET_TEMPLATE_PAGES.length > 0) {
      console.log('🔍 Checking for additional target template pages...');

      for (const targetPageId of TARGET_TEMPLATE_PAGES) {
        try {
          const targetPage = await notion.pages.retrieve({ page_id: targetPageId });
          console.log(`📄 Retrieved target page: ${targetPageId}`);

          // Check if this page is already in our results
          const alreadyExists = workflowPages.some(page => page.id === targetPageId);
          if (!alreadyExists) {
            workflowPages.push({
              id: targetPage.id,
              properties: targetPage.properties,
              date: targetPage.properties.Date?.date?.start ? new Date(targetPage.properties.Date.date.start) : null,
              icon: targetPage.icon,
            });
            console.log(`➕ Added target page ${targetPageId} to workflow pages`);
          }
        } catch (error) {
          console.error(`⚠️ Could not retrieve target page ${targetPageId}:`, error.message);
        }
      }
    }

    return workflowPages;
  } catch (error) {
    console.error('❌ Error getting workflow pages:', error.message);
    console.error('Error details:', error);

    // Provide more specific error messages
    if (error.code === 'unauthorized') {
      throw new Error('Notion API token is invalid or expired');
    } else if (error.code === 'not_found') {
      throw new Error(`Database not found. Please check PRODUCT_WORKFLOWS_DB_ID: ${PRODUCT_WORKFLOWS_DB_ID}`);
    } else if (error.message && error.message.includes('filter')) {
      throw new Error(`Invalid filter for workflow type: ${workflowType}. Check if 'Workflow' property exists in your database.`);
    }

    throw new Error(`Failed to get workflow pages: ${error.message}`);
  }
}

// Process multiple workflows sequentially
async function processMultipleWorkflows(workflowConfigs, targetDate) {
  console.log(`🚀 Processing ${workflowConfigs.length} workflows`);

  const results = [];
  const allEpics = []; // Collect all epics for target date page
  const allTemplateToPageMaps = {}; // Collect all template mappings for dependency resolution
  const allWorkflowPages = {}; // Collect all workflow pages for dependency resolution

  // First pass: collect all epics and process workflows without resolving dependencies
  for (const config of workflowConfigs) {
    try {
      if (!config.epicId) {
        throw new Error(`No epic ID provided for workflow: ${config.name}`);
      }

      // Get epic details and add to all epics collection
      const epicDetails = await getEpicDetails(config.epicId);
      allEpics.push({ id: config.epicId, name: epicDetails.name });

      const result = await processWorkflowCopy(config.epicId, targetDate, config.type, allEpics);
      results.push({
        workflow: config.name,
        success: true,
        pagesCopied: result.pagesCopied || 0,
        templateToPageMap: result.templateToPageMap,
        workflowPages: result.workflowPages,
        epicId: config.epicId
      });

      // Collect template mappings and workflow pages for dependency resolution
      if (result.templateToPageMap) {
        Object.assign(allTemplateToPageMaps, result.templateToPageMap);
      }
      if (result.workflowPages) {
        allWorkflowPages[config.type] = result.workflowPages;
      }

    } catch (error) {
      console.error(`❌ Failed to process workflow ${config.name}:`, error.message);
      results.push({
        workflow: config.name,
        success: false,
        error: error.message,
        epicId: config.epicId
      });
    }
  }

  // Second pass: Resolve dependencies across all workflows
  if (Object.keys(allTemplateToPageMaps).length > 0) {
    console.log(`\n🔗 Resolving cross-workflow dependencies for ${Object.keys(allTemplateToPageMaps).length} pages`);
    await resolveCrossWorkflowDependencies(allTemplateToPageMaps, allWorkflowPages);
  }

  const successful = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`\n📊 Completed: ${successful}/${total} workflows successful`);

  return results;
}

// Resolve dependencies by updating blocking/blocked by properties with correct page IDs
async function resolveDependencies(templateToPageMap, workflowPages, workflowType) {

  for (const workflowPage of workflowPages) {
    try {
      // Get the original template page to check for dependency properties
      const originalPage = await notion.pages.retrieve({ page_id: workflowPage.id });

      // Check for dependency properties
      const blockingProps = ['Blocking', 'Blocks', 'Blocking by'];
      const blockedByProps = ['Blocked by', 'Blocked', 'Blocked_by'];

      let blockingRelations = [];
      let blockedByRelations = [];

      // Extract blocking dependencies
      for (const propName of blockingProps) {
        const prop = originalPage.properties[propName];
        if (prop?.relation && prop.relation.length > 0) {
          blockingRelations = blockingRelations.concat(prop.relation);
        }
      }

      // Extract blocked by dependencies
      for (const propName of blockedByProps) {
        const prop = originalPage.properties[propName];
        if (prop?.relation && prop.relation.length > 0) {
          blockedByRelations = blockedByRelations.concat(prop.relation);
        }
      }

      // If no dependencies found, skip this page
      if (blockingRelations.length === 0 && blockedByRelations.length === 0) {
        continue;
      }

      // Get the new page ID for this template
      const templateName = workflowPage.properties.Name?.title?.[0]?.plain_text ||
                          workflowPage.properties.Name?.rich_text?.[0]?.plain_text ||
                          workflowPage.properties.Title?.title?.[0]?.plain_text;

      if (!templateName || !templateToPageMap[templateName]) {
        console.log(`⚠️ Could not find mapping for template: ${templateName}`);
        continue;
      }

      const newPageId = templateToPageMap[templateName];

      // Prepare updates for blocking and blocked by properties
      const updates = {};

      // Resolve blocking relations (this page blocks other pages)
      if (blockingRelations.length > 0) {
        const resolvedBlockingIds = [];

        for (const relation of blockingRelations) {
          // Try to find the related page in our template mapping
          const relatedPage = await notion.pages.retrieve({ page_id: relation.id });
          const relatedName = relatedPage.properties.Name?.title?.[0]?.plain_text ||
                             relatedPage.properties.Name?.rich_text?.[0]?.plain_text ||
                             relatedPage.properties.Title?.title?.[0]?.plain_text;

          if (relatedName && templateToPageMap[relatedName]) {
            resolvedBlockingIds.push({ id: templateToPageMap[relatedName] });
          }
        }

        if (resolvedBlockingIds.length > 0) {
          updates.Blocking = { relation: resolvedBlockingIds };
        }
      }

      // Resolve blocked by relations (other pages block this page)
      if (blockedByRelations.length > 0) {
        const resolvedBlockedByIds = [];

        for (const relation of blockedByRelations) {
          // Try to find the related page in our template mapping
          const relatedPage = await notion.pages.retrieve({ page_id: relation.id });
          const relatedName = relatedPage.properties.Name?.title?.[0]?.plain_text ||
                             relatedPage.properties.Name?.rich_text?.[0]?.plain_text ||
                             relatedPage.properties.Title?.title?.[0]?.plain_text;

          if (relatedName && templateToPageMap[relatedName]) {
            resolvedBlockedByIds.push({ id: templateToPageMap[relatedName] });
          }
        }

        if (resolvedBlockedByIds.length > 0) {
          updates['Blocked by'] = { relation: resolvedBlockedByIds };
        }
      }

      // Update the page with resolved dependencies
      if (Object.keys(updates).length > 0) {

        await notion.pages.update({
          page_id: newPageId,
          properties: updates
        });

      }

    } catch (error) {
      console.error(`❌ Error resolving dependencies for page ${workflowPage.id}:`, error.message);
      // Continue with other pages even if one fails
    }
  }

  console.log(`🔗 Completed dependency resolution for workflow: ${workflowType}`);
}

// Resolve dependencies across all workflows
async function resolveCrossWorkflowDependencies(allTemplateToPageMaps, allWorkflowPages) {
  // Combine all workflow pages from different workflows
  const allPages = [];
  for (const workflowType in allWorkflowPages) {
    if (allWorkflowPages[workflowType]) {
      allPages.push(...allWorkflowPages[workflowType]);
    }
  }

  if (allPages.length > 0) {
    console.log(`🔗 Resolving dependencies for ${allPages.length} pages`);
  }

  for (const workflowPage of allPages) {
    try {
      // Get the original template page to check for dependency properties
      const originalPage = await notion.pages.retrieve({ page_id: workflowPage.id });

      // Check for dependency properties
      const blockingProps = ['Blocking', 'Blocks', 'Blocking by'];
      const blockedByProps = ['Blocked by', 'Blocked', 'Blocked_by'];

      let blockingRelations = [];
      let blockedByRelations = [];

      // Extract blocking dependencies
      for (const propName of blockingProps) {
        const prop = originalPage.properties[propName];
        if (prop?.relation && prop.relation.length > 0) {
          blockingRelations = blockingRelations.concat(prop.relation);
        }
      }

      // Extract blocked by dependencies
      for (const propName of blockedByProps) {
        const prop = originalPage.properties[propName];
        if (prop?.relation && prop.relation.length > 0) {
          blockedByRelations = blockedByRelations.concat(prop.relation);
        }
      }

      // If no dependencies found, skip this page
      if (blockingRelations.length === 0 && blockedByRelations.length === 0) {
        continue;
      }

      // Get the new page ID for this template
      const templateName = workflowPage.properties.Name?.title?.[0]?.plain_text ||
                          workflowPage.properties.Name?.rich_text?.[0]?.plain_text ||
                          workflowPage.properties.Title?.title?.[0]?.plain_text;

      if (!templateName || !allTemplateToPageMaps[templateName]) {
        console.log(`⚠️ Could not find mapping for template: ${templateName}`);
        continue;
      }

      const newPageId = allTemplateToPageMaps[templateName];

      // Prepare updates for blocking and blocked by properties
      const updates = {};

      // Resolve blocking relations (this page blocks other pages)
      if (blockingRelations.length > 0) {
        const resolvedBlockingIds = [];

        for (const relation of blockingRelations) {
          // Try to find the related page in our template mapping
          const relatedPage = await notion.pages.retrieve({ page_id: relation.id });
          const relatedName = relatedPage.properties.Name?.title?.[0]?.plain_text ||
                             relatedPage.properties.Name?.rich_text?.[0]?.plain_text ||
                             relatedPage.properties.Title?.title?.[0]?.plain_text;

          if (relatedName && allTemplateToPageMaps[relatedName]) {
            resolvedBlockingIds.push({ id: allTemplateToPageMaps[relatedName] });
            console.log(`🔗 Resolved blocking: ${templateName} → ${relatedName}`);
          } else {
            console.log(`⚠️ Could not resolve blocking relation for: ${relatedName || relation.id}`);
          }
        }

        if (resolvedBlockingIds.length > 0) {
          updates.Blocking = { relation: resolvedBlockingIds };
        }
      }

      // Resolve blocked by relations (other pages block this page)
      if (blockedByRelations.length > 0) {
        const resolvedBlockedByIds = [];

        for (const relation of blockedByRelations) {
          // Try to find the related page in our template mapping
          const relatedPage = await notion.pages.retrieve({ page_id: relation.id });
          const relatedName = relatedPage.properties.Name?.title?.[0]?.plain_text ||
                             relatedPage.properties.Name?.rich_text?.[0]?.plain_text ||
                             relatedPage.properties.Title?.title?.[0]?.plain_text;

          if (relatedName && allTemplateToPageMaps[relatedName]) {
            resolvedBlockedByIds.push({ id: allTemplateToPageMaps[relatedName] });
            console.log(`🔗 Resolved blocked by: ${relatedName} → ${templateName}`);
          } else {
            console.log(`⚠️ Could not resolve blocked by relation for: ${relatedName || relation.id}`);
          }
        }

        if (resolvedBlockedByIds.length > 0) {
          updates['Blocked by'] = { relation: resolvedBlockedByIds };
        }
      }

      // Update the page with resolved dependencies
      if (Object.keys(updates).length > 0) {

        await notion.pages.update({
          page_id: newPageId,
          properties: updates
        });

      }

    } catch (error) {
      console.error(`❌ Error resolving cross-workflow dependencies for page ${workflowPage.id}:`, error.message);
      // Continue with other pages even if one fails
    }
  }

  console.log(`🔗 Completed cross-workflow dependency resolution`);
}

// Copy page content (blocks) from source page to destination page
async function copyPageContent(sourcePageId, destinationPageId) {
  try {
    console.log(`📄 Getting blocks from source page: ${sourcePageId}`);

    // Get all blocks from the source page
    const blocksResponse = await notion.blocks.children.list({
      block_id: sourcePageId,
      page_size: 100
    });

    if (!blocksResponse.results || blocksResponse.results.length === 0) {
      return;
    }

    // Prepare blocks for appending (remove properties that can't be copied)
    const blocksToAppend = blocksResponse.results.map(block => {
      const { id, created_time, last_edited_time, created_by, last_edited_by, ...cleanBlock } = block;
      return cleanBlock;
    });

    if (blocksToAppend.length > 0) {
      // Append blocks to the destination page
      await notion.blocks.children.append({
        block_id: destinationPageId,
        children: blocksToAppend
      });

      // Recursively copy child blocks for blocks that have children
      for (const block of blocksResponse.results) {
        if (block.has_children && block.id) {
          await copyChildBlocks(block.id, destinationPageId, blocksToAppend);
        }
      }
    }

  } catch (error) {
    console.error(`❌ Error copying page content:`, error.message);
    throw error;
  }
}

// Recursively copy child blocks
async function copyChildBlocks(sourceBlockId, destinationPageId, parentBlocks) {
  try {
    const childBlocksResponse = await notion.blocks.children.list({
      block_id: sourceBlockId,
      page_size: 100
    });

    if (!childBlocksResponse.results || childBlocksResponse.results.length === 0) {
      return;
    }

    // Find the corresponding block in the destination page
    const destinationBlocksResponse = await notion.blocks.children.list({
      block_id: destinationPageId,
      page_size: 100
    });

    // For simplicity, we'll append child blocks to the last block of the same type
    // This is a simplified approach - in a production system you'd want to match blocks more precisely
    if (destinationBlocksResponse.results && destinationBlocksResponse.results.length > 0) {
      const lastBlock = destinationBlocksResponse.results[destinationBlocksResponse.results.length - 1];

      if (lastBlock.has_children || lastBlock.type === 'column_list' || lastBlock.type === 'column') {
        const childBlocksToAppend = childBlocksResponse.results.map(block => {
          const { id, created_time, last_edited_time, created_by, last_edited_by, ...cleanBlock } = block;
          return cleanBlock;
        });

        await notion.blocks.children.append({
          block_id: lastBlock.id,
          children: childBlocksToAppend
        });
      }
    }

  } catch (error) {
    console.error(`❌ Error copying child blocks:`, error.message);
    // Continue even if child block copying fails
  }
}

// Calculate date translation to maintain relational distance
function calculateDateTranslation(workflowPages, epicFulfillBy) {
  if (!epicFulfillBy || workflowPages.length === 0) {
    return { offset: 0 };
  }

  // Find the latest date in workflow pages
  const pagesWithDates = workflowPages.filter(page => page.date);

  if (pagesWithDates.length === 0) {
    return { offset: 0 };
  }

  const latestWorkflowDate = pagesWithDates.reduce((latest, page) => page.date > latest ? page.date : latest, new Date(0));

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
async function copyPagesToStories(workflowPages, epicDetails, dateTranslation, workflowType = null, allEpics = []) {
  const copiedPages = [];
  const templateToPageMap = {}; // Map template page names to new page IDs
  let targetDatePageCopied = false; // Track if target date page has been copied

  // Get Stories database schema to know which properties are allowed
  console.log('Getting Stories database schema...');
  const storiesSchema = await getDatabaseSchema(STORIES_DB_ID);
  console.log('Stories database properties:', storiesSchema);

  for (const workflowPage of workflowPages) {
    try {
      // Special handling for target date page - only copy once
      const isTargetDatePage = TARGET_TEMPLATE_PAGES.includes(workflowPage.id);
      if (isTargetDatePage && targetDatePageCopied) {
        console.log(`⏭️ Skipping target date page ${workflowPage.id} - already copied`);
        continue;
      }

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

      // Translate dates - handle both single dates and date ranges
      if (newProperties.Date && newProperties.Date.date) {
        const originalDate = newProperties.Date.date;

        // If we have the original workflow page date, use it for translation
        if (workflowPage.date) {
          const translatedDate = new Date(workflowPage.date.getTime() + dateTranslation.offset);

          // Handle date ranges (both start and end dates)
          if (originalDate.start && originalDate.end) {
            const startDate = new Date(originalDate.start);
            const endDate = new Date(originalDate.end);

            // Validate original date range
            if (startDate >= endDate) {
              console.warn(`⚠️ Invalid date range skipped: ${originalDate.start}-${originalDate.end}`);
            } else {
              const duration = endDate.getTime() - startDate.getTime();
              newProperties.Date.date.start = translatedDate.toISOString().split('T')[0];
              const translatedEndDate = new Date(translatedDate.getTime() + duration);

              if (translatedEndDate <= translatedDate) {
                console.warn(`⚠️ Date translation skipped to prevent invalid range`);
              } else {
                newProperties.Date.date.end = translatedEndDate.toISOString().split('T')[0];
              }
            }
          } else if (originalDate.start) {
            // Single date
            newProperties.Date.date.start = translatedDate.toISOString().split('T')[0];
          }
        } else {
          // No translation needed, but ensure dates are valid
          if (originalDate.start && originalDate.end) {
            const startDate = new Date(originalDate.start);
            const endDate = new Date(originalDate.end);

            if (startDate >= endDate) {
              console.warn(`⚠️ Invalid date range: ${originalDate.start}-${originalDate.end}`);
              if (isTargetDatePage) {
                console.warn(`🎯 Target page: date property removed`);
                delete newProperties.Date;
              }
            }
          }
        }
      }

      // Add relation to epic(s) - use all epics for target date page
      if (!newProperties.Epic) {
        if (isTargetDatePage && allEpics.length > 0) {
          // Target date page gets all epics
          newProperties.Epic = {
            relation: allEpics.map(epic => ({ id: epic.id }))
          };
        } else {
          // Regular pages get the current epic
          newProperties.Epic = {
            relation: [{ id: epicDetails.id }]
          };
        }
      }

      // Prepare page creation parameters
      const pageParams = {
        parent: { database_id: STORIES_DB_ID },
        properties: newProperties,
      };

      // Copy icon from source page if it exists
      if (workflowPage.icon) {
        pageParams.icon = workflowPage.icon;
      }

      // Create new page in Stories database
      const newPage = await notion.pages.create(pageParams);
      copiedPages.push(newPage);

      // Copy page content (blocks) from template to new page
      try {
        await copyPageContent(workflowPage.id, newPage.id);
      } catch (contentError) {
        console.error(`⚠️ Content copy failed for ${workflowPage.id}: ${contentError.message}`);
      }

      // Mark target date page as copied
      if (isTargetDatePage) {
        targetDatePageCopied = true;
      }

      // Track the mapping from template page name to new page ID for dependency resolution
      if (originalTitle) {
        templateToPageMap[originalTitle] = newPage.id;
      }
    } catch (error) {
      console.error(`Error copying page ${workflowPage.id}:`, error);

      // Special handling for target date page errors
      if (isTargetDatePage) {
        console.error(`❌ Target page failed: ${workflowPage.id} - ${error.message}`);

        // Try to copy target date page without date property if it's causing validation errors
        if (error.message && error.message.includes('date range')) {
          console.log(`🎯 Retrying target page without date property...`);
          try {
            const retryProperties = { ...newProperties };
            delete retryProperties.Date;

            const retryPageParams = {
              parent: { database_id: STORIES_DB_ID },
              properties: retryProperties,
            };

            if (workflowPage.icon) {
              retryPageParams.icon = workflowPage.icon;
            }

            const retryNewPage = await notion.pages.create(retryPageParams);
            console.log(`✅ Target page copied: ${retryNewPage.id}`);

            copiedPages.push(retryNewPage);
            if (originalTitle) {
              templateToPageMap[originalTitle] = retryNewPage.id;
            }
            targetDatePageCopied = true;
            return;
          } catch (retryError) {
            console.error(`❌ Target page retry failed: ${retryError.message}`);
          }
        }
      }

      // Continue with other pages even if one fails
    }
  }

  return {
    copiedPages,
    templateToPageMap
  };
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
