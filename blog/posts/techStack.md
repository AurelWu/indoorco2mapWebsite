# The Tech Stack of IndoorCO2Map.com

This article gives an overview of the technology stack behind IndoorCO2Map.com. The project has grown over roughly the last 18 months and the stack reflects that — some parts were chosen deliberately from the start, others ended up where they are because they kept working well enough and some I had to rework because it didn't turned out well.

## The Mobile App: .NET MAUI

The app is written in C# using the NET MAUI Framework and runs on both iOS and Android from a single codebase. Most of the business logic and of the user interface is shared with platform-specific code only where it is actually needed — mostly related to GPS and Bluetooth but also for a few UI things.

One thing I noticed during the first versions of the App is that it is quite easy to have the App work well locally but when submitted to the App Stores (even as test versions) it might break for various reasons - often related to things like reflection and specific compilation/linker settings which are required for App Store releases.

This is one of the reasons why, once I realised that, I tried to use as few external libraries beyond what the framework offers itself and instantly checked if there is any issues builds submitted to the App Stores.

The libraries I ended up using are:

- **Plugin.BLE** which makes working with Bluetooth really easy
- **Polly** for all internet connection related things
- **SQlite-net** to create a simple database for location caching and for the local measurement history
- **Mapsui.Maui** for the in-App Map
- **Newtonsoft.Json** for serialisation/deserialisation
- **Community.Toolkit.Maui** which is a collection of useful small tools, lots of it UI related.

## Map Data: From Overpass to Our Own Pipeline

The App uses map data from OpenStreetMap to identify nearby locations and public transit routes. The earlier version of the app queried Overpass Turbo which is a public instance running the Overpass API. The maintainers of that service advise against using their public service for production apps for reliability reasons but were okay with me using it for the App. It worked decently from mid 2024 to mid 2025, it failed rarely and the speed it returned the requests was not perfect but usually within 5 seconds. At some point in mid 2025 it progressively got worse though, I assume mainly because of both AI-Agents using the service and more and more AI-written code also using the service. So I needed to come up with my own solution - a solution which is cheap, reliable and quick.

Hosting my own instance running the Overpass API or a hosting a server with a PostgreSQL database populated and updated via osm2pgsql would still need to be reasonably beefy and would probably cost around 60€ to 100€ per month on a bare metal hosting service.

Both options have in common that there is a server running permanently, even though the app only needs simple location lookups around the user's current position, basically "give me all POIs of certain categories within a small radius around this point".

So instead I went with a static approach and precompute the data on a EC2 Instance once a day into a format that can be served as plain files from S3 and queried directly from the client via HTTP range requests. No server has to be running between pipeline runs and just the S3 Storage costs a bit (traffic costs are negligible), so in total it ends up costing less than 10€ per month.

The pipeline produces PMTiles files. PMTiles is an ingenious* single-file format for vector tiles that supports HTTP range requests, so the client only fetches the tiles it actually needs and there is no tile server in the loop. The files live on S3 and are served via CloudFront. 

This geospatial pipeline is written in Python with the hard stuff being done by the osmium and tippecanoe libraries.

*seriously, look it up and be amazed.

The steps are roughly:

1. Fetch the latest OSM planet PBF from our S3 bucket, apply the daily update and and reupload it there for the next update.
2. Filter to the POI categories we care about with osmium
3. Convert to vector tiles with tippecanoe
4. Pack into a PMTiles file and upload back to S3

There is a separate weekly pipeline for transit data. It produces both a PMTiles file (for stations and route geometries) and a custom binary format I called RT01 which is a file with gzip-compressed per-route blobs with a compressed index. The index is fetched once on the client, the per-route data only when the specific route is selected in the App with an HTTP range request. This keeps the data transfer small even when there is a lot of transit data in a region.

## Submitted Measurements: SQS, Lambda, PostgreSQL

Measurements submitted from the app do not go directly to the database. They go into an messaging queue first. From there, Lambda functions pick them up, validate them and write them into a PostgreSQL database - this ensures that short downtimes of the database don't result in data loss.

## Live Sensor Data: MQTT via EMQX

There is also support for live sensor telemetry, currently still in non-public test mode. Some sensors can send their data directly to HTTP Endpoints, where serverless functions handle it and then write to the database. Some other Sensors only support MQTT, therefore we set up an Server with EMQX as MQTT-broker on a small EC2 instance.

## Website: Plain JavaScript

The website does not use any framework. It is plain JavaScript with three libraries doing the actual work:

- **MapLibre GL** for the base map and the PMTiles layers
- **deck.gl** for the data overlays (heatmaps, points, aggregates), which uses WebGL and stays fast even with a lot of points
- **Chart.js** for the time series and other charts

I'm no web developer so I try to keep things very simple and understandable but I also tried to keep the Webpage ressource efficient and given that the Map page just causes usually less than 200MB RAM usage I think, I did a decent job.

## Bluetooth: Wireshark

Some of the CO₂ sensors do not come with documented Bluetooth protocols. To support a new sensor in the app, the protocol has to be reverse engineered first. Wireshark with Bluetooth HCI capture is the tool I used for that — pair the sensor with a phone or a capable adapter, capture a session, and then work out from the byte patterns what the characteristic UUIDs do, how the readings are encoded and what command sequences are needed. Once that is figured out, it becomes another sensor adapter inside the app. Some sensors are more tricky than others and some have firmware quirks that need to be worked around carefully so the sensor itself does not get into a bad state.

## Smaller Tools: ImageMagick and Inkscape

ImageMagick is used to generate the Icon Atlas used for the different colored pins on the website. Inkscape is used for various SVG-based images (logo, icons, map markers).

## Bash for initialisation 

some Bash scripts tie it all together like the EC2 instance initialisation scripts, data downloads/uploads to/from S3 and calling they python scripts.

## Final Thoughts

I'm just a single person working a challenging day time job and doing this here on the side. While every single piece is not complex, it is a lot of different things required for the Project to work, so the big challenge was and continues to be to keep things as simple and maintenance free as possible.

Therefore the general direction of the stack is to avoid permanently running services where possible, to use serverless for bursty workloads and to not depend on infrastructure that I cannot control if reliability matters. Avoiding Frameworks and keeping library usage to a minimum.

The only things that run continuously are the PostgreSQL database and the EMQX broker, and the latter is small enough to live on a cheap EC2 instance. Everything else is either static files on S3 or runs on demand.